import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../domain/conversation";
import {
  createRemoteToken, normalizePort, parseSendText, REMOTE_DEFAULT_PORT, toRemoteMessages,
} from "../domain/remote";
import {
  listenRemoteRequests, remoteAvailable, remoteStatus, startRemote, stopRemote, type RemoteInfo,
} from "../services/remote/bridge";
import { secretStore } from "../services/storage";

/**
 * 手机远程终端。
 *
 * 手机只是一块屏幕：它把「发一轮」交回桌面端跑，跑完自己再拉一次消息。
 * 所以这里不需要流式，也不需要任何同步逻辑——数据始终只有电脑上那一份。
 *
 * 代价照实说，不粉饰：**电脑不开机手机就用不了**，主动消息也推不到手机
 * （Web Push 要 HTTPS 和 VAPID，局域网自签证书很难受），手机开着的时候才收得到。
 */

/** token 存在加密保险库里，和 API Key 一起，不与业务数据同表。 */
const TOKEN_NAME = "remote.token";

export interface RemoteAccessSource {
  /** 当前全部消息。用 ref 读，回调跑在旧闭包里。 */
  messages: readonly ChatMessage[];
  connected: boolean;
  send(content: string): Promise<unknown>;
}

export function useRemoteAccess(source: RemoteAccessSource) {
  const [available] = useState(remoteAvailable);
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [port, setPort] = useState(REMOTE_DEFAULT_PORT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const sourceRef = useRef(source);
  sourceRef.current = source;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      // 桌面端重载页面时服务可能还开着：先问一声，不要显示成关着的。
      const current = await remoteStatus();
      if (current) {
        setInfo(current);
        setPort(current.port);
      }
      unlisten = await listenRemoteRequests(async (request) => {
        const { messages, connected, send } = sourceRef.current;

        if (request.kind === "messages") {
          return { connected, messages: toRemoteMessages(messages) };
        }

        if (request.kind === "send") {
          const text = parseSendText(request.body);
          if (!text) return { error: "这条消息是空的" };
          if (!connected) return { error: "电脑上还没配置模型，先在设置页填 API Key" };
          await send(text);
          // 不回消息列表：这一轮落库之后手机自己再拉一次，那份才是准的。
          return { ok: true };
        }

        return { error: `不认识的请求：${request.kind}` };
      });
    })();

    return () => unlisten?.();
  }, []);

  const start = useCallback(async (nextPort: number) => {
    const valid = normalizePort(nextPort);
    if (!valid) {
      setError("端口要在 1024 到 65535 之间");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // token 生成一次就一直用：换一次，手机上存的旧链接就全废了。
      const token = (await secretStore.get(TOKEN_NAME)) || createRemoteToken();
      await secretStore.set(TOKEN_NAME, token);
      setInfo(await startRemote(valid, token));
      setPort(valid);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setBusy(false);
    }
  }, []);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await stopRemote();
      setInfo(null);
      setError("");
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError));
    } finally {
      setBusy(false);
    }
  }, []);

  /** 换一把新的 token：手机丢了、或者链接发错了人的时候用。旧链接立刻失效。 */
  const rotateToken = useCallback(async () => {
    setBusy(true);
    try {
      const token = createRemoteToken();
      await secretStore.set(TOKEN_NAME, token);
      const valid = normalizePort(port) ?? REMOTE_DEFAULT_PORT;
      setInfo(await startRemote(valid, token));
      setError("");
    } catch (rotateError) {
      setError(rotateError instanceof Error ? rotateError.message : String(rotateError));
    } finally {
      setBusy(false);
    }
  }, [port]);

  return { available, info, port, setPort, busy, error, start, stop, rotateToken };
}
