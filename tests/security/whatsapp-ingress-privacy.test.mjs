import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../../infra/nginx/newme-platform.conf", import.meta.url), "utf8");
const logName = "newme_whatsapp_webhook_v1";
const allowedVariables = new Set(["$time_iso8601", "$request_id", "$remote_addr", "$request_method",
  "$status", "$body_bytes_sent", "$request_time", "$upstream_status", "$upstream_response_time"]);

function contract(source) {
  const format = source.match(/log_format newme_whatsapp_webhook_v1 escape=json([\s\S]*?);/)?.[1];
  assert.ok(format, "callback structured log format is missing");
  const variables = [...format.matchAll(/\$[a-zA-Z0-9_]+/g)].map((m) => m[0]);
  assert.deepEqual(variables.filter((name) => !allowedVariables.has(name)), [], "unsafe request data is logged");
  for (const name of ["$request_id", "$remote_addr", "$status", "$upstream_status"]) {
    assert.ok(variables.includes(name), `security outcome ${name} is missing`);
  }
  assert.ok(format.includes('"path":"/api/whatsapp/webhook"'));
  const locations = [...source.matchAll(/location = \/api\/whatsapp\/webhook \{([\s\S]*?)\n    \}/g)].map((m) => m[1]);
  assert.equal(locations.length, 2, "both TLS and plaintext callback locations must be explicit");
  for (const location of locations) {
    assert.ok(location.includes(`access_log /var/log/nginx/newme-whatsapp-access.log ${logName};`));
    assert.ok(location.includes("error_log /dev/null;"), "original queries can leak in Nginx error messages");
    assert.doesNotMatch(location, /access_log\s+off/);
  }
  const tls = locations.find((location) => location.includes("proxy_pass"));
  const plain = locations.find((location) => location.includes("return 400;"));
  assert.ok(tls && plain);
  for (const directive of ["limit_req zone=api burst=50 nodelay;", "limit_req_status 429;",
    "client_max_body_size 1m;", "client_body_buffer_size 1m;", "proxy_request_buffering off;",
    "proxy_http_version 1.1;", "proxy_pass http://127.0.0.1:3001;"]) {
    assert.ok(tls.includes(directive), `missing callback directive: ${directive}`);
  }
  assert.doesNotMatch(plain, /proxy_pass|return 30[1278]/);
}

test("callback logs retain security outcomes without query, header or body data", () => contract(config));
for (const variable of ["$request", "$request_uri", "$args", "$http_referer", "$http_x_hub_signature_256"]) {
  test(`rejects logging ${variable}`, () => {
    assert.throws(() => contract(config.replace('"method":"$request_method"', `"leak":"${variable}"`)), /unsafe request data/);
  });
}
test("rejects removing rate-limit or upstream outcome evidence", () => {
  assert.throws(() => contract(config.replace("limit_req zone=api burst=50 nodelay;\n        limit_req_status 429;", "limit_req zone=api burst=50 nodelay;\n        limit_req_status 503;")));
  assert.throws(() => contract(config.replace('"upstream_status":"$upstream_status",', "")));
});
test("rejects disk buffering or a larger body limit for the signed callback", () => {
  assert.throws(() => contract(config.replace("proxy_request_buffering off;", "proxy_request_buffering on;")));
  assert.throws(() => contract(config.replace("client_max_body_size 1m;", "client_max_body_size 2m;")));
});
test("rejects default error logging or disabling callback access evidence", () => {
  assert.throws(() => contract(config.replace("error_log /dev/null;", "error_log /var/log/nginx/error.log;")));
  assert.throws(() => contract(config.replace(`access_log /var/log/nginx/newme-whatsapp-access.log ${logName};`, "access_log off;")));
});
