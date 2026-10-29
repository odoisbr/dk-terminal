const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PreviewBridge } = require('../electron/preview-bridge.cjs');
function send(port, token, body, extra = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname:'127.0.0.1', port, path:'/preview', method:'POST', headers: { authorization: `Bearer ${token}`, 'content-type':'application/json', ...extra } }, response => {
      let data=''; response.on('data', chunk => data += chunk); response.on('end', () => resolve({ status:response.statusCode, data:JSON.parse(data) }));
    }); request.on('error', reject); request.end(JSON.stringify(body));
  });
}
test('ponte aceita apenas origem autorizada e URL local, e depende da confirmação da interface', async t => {
  let events=[]; const bridge = new PreviewBridge(event => { events.push(event); bridge.finish(event.id, true); });
  await bridge.start(); t.after(() => bridge.close());
  const a=bridge.environment('/project-a'), b=bridge.environment('/project-b');
  assert.notEqual(a.DK_TERMINAL_PREVIEW_TOKEN, b.DK_TERMINAL_PREVIEW_TOKEN);
  const port=bridge.port, token=a.DK_TERMINAL_PREVIEW_TOKEN;
  assert.equal((await send(port,token,{url:'http://127.0.0.1:1234/'})).status,200);
  assert.equal(events[0].root,'/project-a');
  assert.equal((await send(port,token,{url:'https://example.com'})).status,400);
  assert.equal((await send(port,token,{url:'file:///etc/passwd'})).status,400);
  assert.equal((await send(port,'bad',{url:'http://localhost:1234'})).status,403);
  assert.equal((await send(port,token,{url:'http://localhost:1234'},{origin:'http://localhost:1234'})).status,403);
  assert.equal((await send(port,token,{url:'http://localhost:1234',root:'/project-b'})).status,400);
  bridge.revoke('/project-a');
  assert.equal((await send(port,token,{url:'http://localhost:1234'})).status,403);
  const refuse = new PreviewBridge(event => refuse.finish(event.id,false)); await refuse.start(); t.after(() => refuse.close());
  assert.equal((await send(refuse.port,refuse.environment('/a').DK_TERMINAL_PREVIEW_TOKEN,{url:'http://localhost:1234'})).status,409);
});
