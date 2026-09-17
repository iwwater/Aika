/** Read at request construction. Historic messages are never used as the current clock. */
export function hostClock(now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if(!Number.isFinite(now.getTime()))throw Error('Invalid host time');
  const localDateTime=new Intl.DateTimeFormat('zh-CN',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(now);
  return {iso:now.toISOString(),timeZone,localDateTime};
}
