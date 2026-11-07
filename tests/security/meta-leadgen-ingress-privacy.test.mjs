// S7 / review 5-logging-monitoring F9: Meta's verification GET puts
// hub.verify_token in the query string, and the default nginx log format copied it
// into access.log (4 times, readable by the adm group, kept 14 days). The webhook
// now has its own structured log that never contains the request line or query.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const config = readFileSync(new URL("../../infra/nginx/newme-platform.conf", import.meta.url), "utf8");
const allowed = new Set(["$time_iso8601", "$request_id", "$remote_addr", "$request_method", "$status",
  "$body_bytes_sent", "$request_time", "$upstream_status", "$upstream_response_time"]);

function contract(source) {
  const format = source.match(/log_format newme_meta_leadgen_v1 escape=json([\s\S]*?);/)?.[1];
  assert.ok(format, "meta webhook log format is missing");
  const variables = [...format.matchAll(/\$[a-zA-Z0-9_]+/g)].map((m) => m[0]);
  assert.deepEqual(variables.filter((name) => !allowed.has(name)), [], "unsafe request data is logged");
  assert.ok(format.includes('"path":"/api/meta/leadgen-webhook"'));
  const locations = [...source.matchAll(/location = \/api\/meta\/leadgen-webhook \{([\s\S]*?)\n    \}/g)].map((m) => m[1]);
  assert.equal(locations.length, 2, "TLS and plaintext locations must both be explicit");
  for (const location of locations) {
    assert.ok(location.includes("access_log /var/log/nginx/newme-meta-leadgen-access.log newme_meta_leadgen_v1;"));
    assert.ok(location.includes("error_log /dev/null;"), "nginx error lines can quote the query");
  }
  assert.ok(locations.some((l) => l.includes("proxy_pass http://127.0.0.1:3001;")));
  assert.ok(locations.some((l) => l.includes("return 400;") && !l.includes("proxy_pass")), "plaintext must not proxy or redirect");
}

test("meta leadgen webhook logs outcomes without the query string", () => contract(config));
for (const variable of ["$request", "$request_uri", "$args", "$query_string", "$http_referer"]) {
  test(`rejects logging ${variable}`, () => {
    const start = config.indexOf("log_format newme_meta_leadgen_v1");
    const tampered = config.slice(0, start) + config.slice(start).replace('"method":"$request_method"', `"leak":"${variable}"`);
    assert.throws(() => contract(tampered), /unsafe request data/);
  });
}
test("the token-bearing verification path is not left on the generic /api/ location", () => {
  assert.ok(config.indexOf("location = /api/meta/leadgen-webhook") < config.indexOf("location /api/ {"));
});
