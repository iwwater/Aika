/** A bounded local control grammar, before all generative work classification. */
export function isClearUnknownReminderCommand(text: string): boolean {
  if (text.length > 100) return false;
  const value = text.normalize('NFKC').replace(/\s+/g, '').replace(/[。.!！,，]/g, '');
  const prefix = '(?:请|请帮我|帮我|麻烦你|麻烦帮我)?';
  const object = '(?:这些|这|全部|所有)?待(?:核对|核实)(?:的)?(?:(?:[一二两三四五六七八九十0-9]+)(?:项|条|个))?(?:(?:的)?(?:提醒|通知|提示|这个案))?';
  const action = '(?:清除|清掉|清理掉|隐藏|取消掉|取消)';
  return new RegExp('^' + prefix + '(?:' + action + '(?:一下)?' + object + '|把' + object + action + ')(?:一下|吧)?$').test(value);
}
