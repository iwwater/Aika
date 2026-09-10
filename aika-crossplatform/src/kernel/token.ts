/**
 * 服务标识。
 *
 * 字符串裸键在重命名时会静默失效——改了提供方的键名，消费方还在用旧字符串，
 * 编译期一声不吭，运行期才炸。所以对外只暴露带类型的 token。
 *
 * 内核对 token 是不透明的：它只比较 key，不理解含义。内核自己**不创建任何
 * token 实例**，一个都没有；创建 token 是各业务模块的事，定义在它们各自的
 * 接口旁边。这条由 architecture.test.ts 守着。
 */

declare const serviceBrand: unique symbol;

export interface ServiceToken<T> {
  readonly key: string;
  /** 仅用于类型推导，运行期不存在这个字段。 */
  readonly [serviceBrand]?: T;
}

/**
 * 声明一个服务标识。
 *
 * key 是注册表里的唯一身份：两个 token 对象只要 key 相同就指同一个服务，
 * 这样即使模块被打包重复实例化，也不会分裂成两份注册。
 */
export function token<T>(key: string): ServiceToken<T> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("service token key must not be empty");
  return { key: trimmed } as ServiceToken<T>;
}

/** 日志里用；不要拿它当身份比较，身份只看 key。 */
export function describeToken(target: ServiceToken<unknown>): string {
  return target.key;
}
