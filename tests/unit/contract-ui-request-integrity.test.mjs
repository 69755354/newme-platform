import assert from "node:assert/strict";
import { File } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildFullAmountInstallment,
  buildPercentageInstallments,
  createUploadAttempt,
  fileMd5Base64,
  submissionIdempotencyKey,
  uploadContractFile,
} from "../../src/lib/client-request-integrity.ts";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("contract UI callers use the atomic idempotent and verified-upload protocols", async () => {
  const [list, detail, create, convert, helper] = await Promise.all([
    read("src/app/(dashboard)/contracts/page.tsx"),
    read("src/app/(dashboard)/contracts/[id]/page.tsx"),
    read("src/app/(dashboard)/contracts/new/page.tsx"),
    read("src/app/(dashboard)/quotes/quote-detail-dialog.tsx"),
    read("src/lib/client-request-integrity.ts"),
  ]);
  for (const uploader of [list, detail]) {
    assert.match(uploader, /uploadContractFile\(/);
    assert.doesNotMatch(uploader, /JSON\.stringify\(\{ key, filename: file\.name, size: file\.size \}\)/);
    assert.doesNotMatch(uploader, /new XMLHttpRequest\(/);
    assert.match(uploader, /uploadAttemptRef\.current = null/);
  }
  assert.match(create, /"Idempotency-Key": attempt\.workflowKey/);
  assert.match(create, /submissionIdempotencyKey\([\s\S]*?"contract\.create\.ui"/);
  assert.match(create, /createAttemptRef\.current/);
  assert.match(create, /inputIdentity/);
  assert.match(create, /body: JSON\.stringify\(attempt\.payload\)/);
  assert.match(create, /createAttemptRef\.current = null/);
  assert.match(convert, /"Idempotency-Key": attempt\.workflowKey/);
  assert.match(convert, /conversionAttemptsRef\.current\.get\(quote\.id\)/);
  assert.match(convert, /body: JSON\.stringify\(attempt\.payload\)/);
  assert.match(convert, /conversionAttemptsRef\.current\.delete\(quote\.id\)/);
  assert.match(convert, /buildFullAmountInstallment\(Number\(quote\.total_amount\), dueDate\)/);
  for (const token of [
    "content_type: contentType", "size: file.size", "content_md5: contentMd5",
    "idempotency_key: idempotencyKey", '"Content-Length"', '"Content-MD5"',
    '"Content-Type"', '"x-cos-meta-md5"',
  ]) assert.ok(helper.includes(token), `missing upload contract token: ${token}`);
  assert.match(helper, /body: JSON\.stringify\(\{ file_id: registration\.file_id \}\)/);
});

test("client integrity helper hashes, signs, uploads, confirms, and replays deterministically", async (t) => {
  assert.equal(await fileMd5Base64(new Blob([])), "1B2M2Y8AsgTpgAmY7PhCfg==");
  assert.equal(await fileMd5Base64(new Blob(["abc"])), "kAFQmDzST7DWlj99KOF/cg==");
  assert.equal(await fileMd5Base64(new Blob(["hello"])), "XUFAKrxLKna5cZ2REBfFkg==");
  const largeBytes = new Uint8Array(4 * 1024 * 1024 + 17);
  for (let index = 0; index < largeBytes.length; index += 1) largeBytes[index] = index % 251;
  assert.equal(
    await fileMd5Base64(new Blob([largeBytes])),
    createHash("md5").update(largeBytes).digest("base64"),
  );
  const dueDate = "2026-09-02";
  const installments = buildFullAmountInstallment(1234.56, dueDate);
  assert.deepEqual(installments, [{
    seq: 1,
    amount: 1234.56,
    due_date: dueDate,
    description: "Full quotation amount",
  }]);
  assert.equal(installments.reduce((sum, row) => sum + row.amount, 0), 1234.56);
  const percentageInstallments = buildPercentageInstallments(
    100.01,
    [33, 33, 34],
    [0, 30, 60],
    new Date("2026-08-03T12:00:00.000Z"),
  );
  assert.deepEqual(percentageInstallments.map((row) => row.amount), [33, 33, 34.01]);
  assert.deepEqual(percentageInstallments.map((row) => row.due_date), [
    "2026-08-03", "2026-09-02", "2026-10-02",
  ]);
  assert.equal(
    Math.round(percentageInstallments.reduce((sum, row) => sum + row.amount, 0) * 100),
    10001,
  );
  assert.throws(() => buildFullAmountInstallment(1.001, dueDate), /invalid_conversion_installment/);
  assert.throws(() => buildFullAmountInstallment(1, "03-09-2026"), /invalid_conversion_installment/);
  assert.throws(
    () => buildPercentageInstallments(1, [50, 40], [0, 30], new Date()),
    /invalid_contract_installments/,
  );

  const session = "0123456789abcdef0123456789abcdef";
  const payload = { installments };
  const firstKey = await submissionIdempotencyKey("quotation.convert.ui", session, payload);
  const replayKey = await submissionIdempotencyKey("quotation.convert.ui", session, payload);
  const changedKey = await submissionIdempotencyKey(
    "quotation.convert.ui",
    session,
    { installments: buildFullAmountInstallment(1234.55, dueDate) },
  );
  assert.equal(replayKey, firstKey);
  assert.notEqual(changedKey, firstKey);
  assert.match(firstKey, /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/);

  const originalFetch = globalThis.fetch;
  const originalXhr = globalThis.XMLHttpRequest;
  const requests = [];
  const providerRequests = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.XMLHttpRequest = originalXhr;
  });

  const registrationFailures = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/upload-url")) {
      const failure = registrationFailures.shift();
      if (failure) return Response.json({ error: failure.error }, { status: failure.status });
      return Response.json({
        file_id: "78000000-7000-4000-8000-000000000001",
        url: "https://example.cos.invalid/signed-object",
        headers: {
          "Content-Length": "14",
          "Content-MD5": "ajcBLszHG9GkoAX6YXq9yQ==",
          "Content-Type": "application/pdf",
          "x-cos-meta-md5": "ajcBLszHG9GkoAX6YXq9yQ==",
        },
      });
    }
    return Response.json({ success: true });
  };

  globalThis.XMLHttpRequest = class FakeXmlHttpRequest {
    upload = {};
    status = 204;
    headers = {};
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    send(body) {
      providerRequests.push({
        method: this.method,
        url: this.url,
        headers: this.headers,
        body,
      });
      this.upload.onprogress?.({ lengthComputable: true, loaded: body.size, total: body.size });
      queueMicrotask(() => this.onload?.());
    }
  };

  const file = new File(["contract bytes"], "contract.pdf", {
    type: "application/pdf",
    lastModified: 1_786_000_000_000,
  });
  const expectedMd5 = await fileMd5Base64(file);
  assert.equal(expectedMd5, "ajcBLszHG9GkoAX6YXq9yQ==");
  const progress = [];
  const uploadAttempt = createUploadAttempt();
  uploadAttempt.sessionId = session;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal(
      await uploadContractFile(
        "78000000-2000-4000-8000-000000000001",
        file,
        uploadAttempt,
        (percentage) => progress.push(percentage),
      ),
      "78000000-7000-4000-8000-000000000001",
    );
  }

  const registrationRequests = requests.filter(({ url }) => url.endsWith("/upload-url"));
  const confirmationRequests = requests.filter(({ url }) => url.endsWith("/confirm-upload"));
  assert.equal(registrationRequests.length, 2);
  assert.equal(confirmationRequests.length, 2);
  const registrationBodies = registrationRequests.map(({ options }) => JSON.parse(options.body));
  assert.deepEqual(registrationBodies[0], registrationBodies[1]);
  assert.deepEqual(registrationBodies[0], {
    filename: "contract.pdf",
    version: "draft",
    content_type: "application/pdf",
    size: 14,
    content_md5: expectedMd5,
    idempotency_key: registrationBodies[0].idempotency_key,
  });
  assert.match(registrationBodies[0].idempotency_key, /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/);
  for (const { options } of confirmationRequests) {
    assert.deepEqual(JSON.parse(options.body), {
      file_id: "78000000-7000-4000-8000-000000000001",
    });
  }
  assert.equal(providerRequests.length, 2);
  for (const providerRequest of providerRequests) {
    assert.equal(providerRequest.method, "PUT");
    assert.equal(providerRequest.body, file);
    assert.equal(providerRequest.body.size, 14);
    assert.deepEqual(providerRequest.headers, {
      "Content-MD5": expectedMd5,
      "Content-Type": "application/pdf",
      "x-cos-meta-md5": expectedMd5,
    });
  }
  assert.deepEqual(progress, [100, 100]);

  const expiringAttempt = createUploadAttempt();
  const expiringSession = expiringAttempt.sessionId;
  registrationFailures.push({
    status: 409,
    error: "upload_url_expiring_new_idempotency_key_required",
  });
  await uploadContractFile(
    "78000000-2000-4000-8000-000000000001",
    file,
    expiringAttempt,
    () => {},
  );
  assert.notEqual(expiringAttempt.sessionId, expiringSession);

  const retainedAttempt = createUploadAttempt();
  const retainedSession = retainedAttempt.sessionId;
  registrationFailures.push({ status: 503, error: "storage_provider_unavailable" });
  await assert.rejects(
    uploadContractFile(
      "78000000-2000-4000-8000-000000000001",
      file,
      retainedAttempt,
      () => {},
    ),
    /storage_provider_unavailable/,
  );
  assert.equal(retainedAttempt.sessionId, retainedSession);
});
