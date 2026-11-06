/** Server-Sent Events 小工具：登录二维码状态、作业日志都走它 */
export function openSse(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  ping.unref?.();
  const close = () => {
    clearInterval(ping);
    res.end();
  };
  req.on('close', close);
  return { send: (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`), close };
}
