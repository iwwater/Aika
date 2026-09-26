// N07-02: CharacterSourceProvider implementations.
// Supports local text/file sources and explicit HTTP(S) Wiki sources with HTML sanitization,
// heading extraction, login wall detection, error reporting, and cancellation.

import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import type {
  CharacterSourceProvider,
  CharacterSourceRef,
  FetchSourceResult,
} from '../contracts/character-pack.js';
import { CharacterPackError } from '../contracts/character-pack.js';
import { checkAbort } from '../media/scope.js';

export class TextSourceProvider implements CharacterSourceProvider {
  constructor(private readonly baseDir?: string | undefined) {}

  canHandle(ref: CharacterSourceRef): boolean {
    if (ref.kind === 'text') return true;
    if (ref.kind === 'file') return true;
    return !ref.uri.startsWith('http://') && !ref.uri.startsWith('https://');
  }

  async fetch(ref: CharacterSourceRef, signal?: AbortSignal): Promise<FetchSourceResult> {
    if (signal) checkAbort(signal);

    if (ref.kind === 'text' || (ref.text !== undefined && ref.text !== null)) {
      const sourceName = ref.title?.trim() || ref.uri || 'inline_text.txt';
      return Object.freeze({
        sourceName,
        text: ref.text ?? '',
        kind: 'text',
        uri: ref.uri,
      });
    }

    // Local file handling
    const filePath = ref.uri;
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    if (!['.txt', '.md', '.markdown'].includes(ext)) {
      throw new CharacterPackError(
        'unsupported_source',
        `不支持的文件格式: "${ext}"，仅支持 .txt, .md, .markdown。`,
      );
    }

    try {
      const content = await readFile(filePath, 'utf8');
      if (signal) checkAbort(signal);
      return Object.freeze({
        sourceName: ref.title?.trim() || basename(filePath),
        text: content,
        kind: 'file',
        uri: filePath,
      });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new CharacterPackError('source_fetch_failed', `读取本地文件失败: ${msg}`);
    }
  }
}

export interface HttpWikiProviderOptions {
  readonly fetcher?: typeof fetch | undefined;
  readonly allowPrivateHosts?: boolean | undefined;
  readonly userAgent?: string | undefined;
}

export class HttpWikiSourceProvider implements CharacterSourceProvider {
  private readonly fetcher: typeof fetch;
  private readonly allowPrivateHosts: boolean;
  private readonly userAgent: string;

  constructor(options: HttpWikiProviderOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.allowPrivateHosts = options.allowPrivateHosts ?? false;
    this.userAgent = options.userAgent ?? 'Aika-Continuity-Wiki-Fetcher/0.7';
  }

  canHandle(ref: CharacterSourceRef): boolean {
    if (ref.kind === 'http_wiki') return true;
    return ref.uri.startsWith('http://') || ref.uri.startsWith('https://');
  }

  async fetch(ref: CharacterSourceRef, signal?: AbortSignal): Promise<FetchSourceResult> {
    if (signal) checkAbort(signal);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(ref.uri);
    } catch {
      throw new CharacterPackError('invalid_request', `非法 URL: "${ref.uri}"`);
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new CharacterPackError('unsupported_source', `不支持的协议 "${parsedUrl.protocol}"，必须为 http: 或 https:`);
    }

    // SSRF protection: reject private IP ranges unless explicitly allowed
    if (!this.allowPrivateHosts) {
      const hostname = parsedUrl.hostname.toLowerCase();
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname.startsWith('192.168.') ||
        hostname.startsWith('10.') ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
      ) {
        throw new CharacterPackError('source_fetch_failed', `禁止请求局域网或私有地址: "${hostname}"`);
      }
    }

    let response: Response;
    try {
      response = await this.fetcher(parsedUrl.href, {
        method: 'GET',
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'text/html,text/markdown,text/plain;q=0.9,*/*;q=0.8',
        },
        ...(signal ? { signal } : {}),
        redirect: 'follow',
      });
    } catch (err: unknown) {
      if (signal?.aborted) {
        throw new CharacterPackError('aborted', '网络请求已被中断取消。');
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new CharacterPackError('source_fetch_failed', `Wiki 页面拉取失败: ${msg}`);
    }

    if (!response.ok) {
      throw new CharacterPackError(
        'source_fetch_failed',
        `Wiki 服务器返回错误状态码 HTTP ${response.status} (${response.statusText || 'Unknown'})`,
      );
    }

    const contentType = response.headers.get('content-type') || '';
    const rawBody = await response.text();

    if (signal) checkAbort(signal);

    let cleanText: string;
    let title: string | undefined = ref.title?.trim();

    if (contentType.includes('text/html') || /<html[\s>]/i.test(rawBody)) {
      const sanitized = this.sanitizeWikiHtml(rawBody);
      cleanText = sanitized.text;
      if (!title && sanitized.title) {
        title = sanitized.title;
      }
    } else {
      cleanText = rawBody.trim();
    }

    if (!cleanText || cleanText.length < 10) {
      throw new CharacterPackError(
        'source_fetch_failed',
        'Wiki 页面正文为空或有效字符过少，可能需要登录认证或为动态渲染脚本。',
      );
    }

    // Determine derived sourceName
    let name = title;
    if (!name) {
      const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
      name = pathSegments.length > 0 ? decodeURIComponent(pathSegments[pathSegments.length - 1]!) : parsedUrl.hostname;
    }
    if (!name.endsWith('.md') && !name.endsWith('.txt')) {
      name = `${name}.md`;
    }

    return Object.freeze({
      sourceName: name,
      text: cleanText,
      kind: 'http_wiki',
      uri: parsedUrl.href,
      metadata: Object.freeze({
        statusCode: response.status,
        contentType,
        fetchedAt: new Date().toISOString(),
      }),
    });
  }

  /**
   * Cleans HTML:
   * 1. Strips <script>, <style>, <nav>, <footer>, <noscript>, and HTML comments.
   * 2. Detects login wall cues.
   * 3. Extracts page <title> or <h1>.
   * 4. Converts <h1>-<h6> to Markdown headers (#, ##, etc.).
   * 5. Converts <p>, <br>, <li> to appropriate line breaks.
   * 6. Unescapes HTML entities.
   */
  private sanitizeWikiHtml(html: string): { text: string; title?: string | undefined } {
    // Check for login wall indicators
    if (
      /class="[^"]*(?:login-required|auth-wall|paywall|permission-denied)[^"]*"/i.test(html) ||
      /<title>.*(?:登录|Login|Sign in|Access Denied).*<\/title>/i.test(html)
    ) {
      throw new CharacterPackError('source_fetch_failed', '目标 Wiki 页面包含登录墙或访问权限受限。');
    }

    // Extract title
    let title: string | undefined;
    const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
    if (titleMatch && titleMatch[1]) {
      title = titleMatch[1].trim().replace(/\s*[-_–|].*$/, ''); // strip site suffix
    }

    // Remove unwanted blocks
    let cleaned = html
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
      .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '')
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '');

    // Convert headings to Markdown
    cleaned = cleaned
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n')
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n')
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n')
      .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, '\n\n#### $1\n\n');

    // Convert line breaks and lists
    cleaned = cleaned
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
      .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n\n$1\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '\n$1\n');

    // Strip all remaining tags
    cleaned = cleaned.replace(/<[^>]+>/g, '');

    // Unescape entities
    cleaned = cleaned
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');

    // Normalize whitespace: collapse multiple empty lines into at most 2
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    return { text: cleaned, title };
  }
}

export class CompositeCharacterSourceProvider implements CharacterSourceProvider {
  private readonly providers: CharacterSourceProvider[];

  constructor(providers?: readonly CharacterSourceProvider[] | undefined) {
    this.providers = providers ? [...providers] : [new HttpWikiSourceProvider(), new TextSourceProvider()];
  }

  canHandle(ref: CharacterSourceRef): boolean {
    return this.providers.some(p => p.canHandle(ref));
  }

  async fetch(ref: CharacterSourceRef, signal?: AbortSignal): Promise<FetchSourceResult> {
    for (const provider of this.providers) {
      if (provider.canHandle(ref)) {
        return provider.fetch(ref, signal);
      }
    }
    throw new CharacterPackError('unsupported_source', `未找到可处理该资料来源的 Provider: "${ref.uri}"`);
  }
}
