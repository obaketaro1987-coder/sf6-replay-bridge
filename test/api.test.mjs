import assert from "node:assert/strict";
import test from "node:test";
import matchesHandler from "../api/matches.js";
import uploadHandler from "../api/upload.js";

function mockResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
  };
}

test("upload status reports an unconfigured deployment", async () => {
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  const previousKey = process.env.RECORDER_API_KEY;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.RECORDER_API_KEY;
  try {
    const response = mockResponse();
    await uploadHandler({ method: "GET", headers: {} }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.configured, false);
  } finally {
    if (previousToken !== undefined) process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    if (previousKey !== undefined) process.env.RECORDER_API_KEY = previousKey;
  }
});

test("matches reports missing Blob configuration", async () => {
  const previousToken = process.env.BLOB_READ_WRITE_TOKEN;
  const previousStore = process.env.BLOB_STORE_ID;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  try {
    const response = mockResponse();
    await matchesHandler({ method: "GET", headers: {} }, response);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.configured, false);
    assert.deepEqual(response.body.matches, []);
  } finally {
    if (previousToken !== undefined) process.env.BLOB_READ_WRITE_TOKEN = previousToken;
    if (previousStore !== undefined) process.env.BLOB_STORE_ID = previousStore;
  }
});
