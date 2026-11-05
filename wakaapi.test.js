"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  authorizationHeader,
  collectWaka,
} = require("./wakaapi");

const TEMPLATE = [
  "Wakatime Status (Last Update: ${UPDATE_TIME})",
  "",
  "- time spent with wakatime:",
  "            ${TOTAL_TIME}",
  "",
  "- coding time over the Last 7 Days：",
  "            ${LAST_7_DAYS}",
  "",
  "- top 3 languages:",
  "",
  "${TOP_3_LANGUAGES}",
].join("\n");

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

test("OAuth access tokens are sent as Bearer credentials", () => {
  assert.equal(authorizationHeader("waka_tok_abc"), "Bearer waka_tok_abc");
});

test("non-token secrets keep HTTP Basic auth", () => {
  assert.equal(
    authorizationHeader("12345"),
    "Basic " + Buffer.from("12345").toString("base64")
  );
});

test("a 401 error body is reported instead of reading data.is_up_to_date", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers.Authorization });
    return jsonResponse(401, { errors: ["Unauthorized."] });
  };

  await assert.rejects(
    () =>
      collectWaka({
        apiKey: "plugin-api-key",
        fetchImpl,
        sleep: async () => {
          throw new Error("auth failures must not be retried");
        },
        now: () => "2026-11-05, 12:00:00",
        template: TEMPLATE,
      }),
    (err) => {
      assert.equal(err instanceof TypeError, false);
      assert.match(err.message, /WakaTime 401: Unauthorized\. Plugin API keys are write-only/);
      assert.match(err.message, /https:\/\/wakatime.com\/oauth/);
      return true;
    }
  );

  assert.equal(calls.length, 3);
  assert.equal(calls[0].authorization, authorizationHeader("plugin-api-key"));
});

test("OAuth tokens authorize every read request with Bearer", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), authorization: options.headers.Authorization });
    if (String(url).includes("/stats")) {
      return jsonResponse(200, {
        data: {
          is_up_to_date: true,
          languages: [
            { name: "Go", decimal: "10.00", text: "10 hrs" },
            { name: "C++", decimal: "5.00", text: "5 hrs" },
            { name: "Python", decimal: "2.50", text: "2 hrs 30 mins" },
          ],
        },
      });
    }
    if (String(url).includes("/summaries")) {
      return jsonResponse(200, { cumulative_total: { text: "7 hrs" } });
    }
    return jsonResponse(200, { data: { text: "100 hrs", is_up_to_date: true } });
  };

  const readme = await collectWaka({
    apiKey: "waka_tok_readme",
    fetchImpl,
    sleep: async () => {},
    now: () => "2026-11-05, 12:00:00",
    template: TEMPLATE,
  });

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.authorization, "Bearer waka_tok_readme");
    assert.equal(call.url.includes("api_key="), false);
    assert.equal(call.url.includes("waka_tok_readme"), false);
  }
  assert.match(readme, /Last Update: 2026-11-05, 12:00:00/);
  assert.match(readme, /100 hrs/);
  assert.match(readme, /7 hrs/);
  assert.match(readme, /Go\s+\|==================================\| 10 hrs/);
  assert.match(readme, /C\+\+\s+\|=================\| 5 hrs/);
  assert.match(readme, /Python \|========\| 2 hrs 30 mins/);
});

test("a Bearer 401 falls back to Basic auth for the same OAuth token", async () => {
  const authorizations = [];
  const fetchImpl = async (url, options) => {
    const authorization = options.headers.Authorization;
    authorizations.push(authorization);
    if (authorization.startsWith("Bearer ")) {
      return jsonResponse(401, { error: "Unauthorized" });
    }
    if (String(url).includes("/stats")) {
      return jsonResponse(200, {
        data: {
          is_up_to_date: true,
          languages: [
            { name: "Go", decimal: "1", text: "1 hr" },
            { name: "C", decimal: "1", text: "1 hr" },
            { name: "Py", decimal: "1", text: "1 hr" },
          ],
        },
      });
    }
    if (String(url).includes("/summaries")) {
      return jsonResponse(200, { cumulative_total: { text: "1 hr" } });
    }
    return jsonResponse(200, { data: { text: "2 hrs", is_up_to_date: true } });
  };

  const readme = await collectWaka({
    apiKey: "waka_tok_fallback",
    fetchImpl,
    sleep: async () => {
      throw new Error("auth fallback must not use the stale-stats retry");
    },
    now: () => "2026-11-05, 12:00:00",
    template: TEMPLATE,
  });

  assert.match(readme, /2 hrs/);
  assert.ok(authorizations.includes("Bearer waka_tok_fallback"));
  assert.ok(authorizations.includes("Basic " + Buffer.from("waka_tok_fallback").toString("base64")));
});

test("stale stats are retried and languages without decimal use total_seconds", async () => {
  let statsCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/stats")) {
      statsCalls += 1;
      if (statsCalls === 1) {
        return jsonResponse(202, {
          data: {
            is_up_to_date: false,
            languages: [{ name: "Go", decimal: "1", text: "1 hr" }],
          },
        });
      }
      return jsonResponse(200, {
        data: {
          is_up_to_date: true,
          languages: [
            { name: "Go", total_seconds: 36000, text: "10 hrs" },
            { name: "Rust", total_seconds: 18000, text: "5 hrs" },
            { name: "C", total_seconds: 9000, text: "2 hrs 30 mins" },
          ],
        },
      });
    }
    if (String(url).includes("/summaries")) {
      return jsonResponse(200, { cumulative_total: { text: "1 hr" } });
    }
    return jsonResponse(200, { data: { text: "2 hrs", is_up_to_date: true } });
  };

  const readme = await collectWaka({
    apiKey: "waka_tok_readme",
    fetchImpl,
    sleep: async () => {},
    now: () => "2026-11-05, 12:00:00",
    template: TEMPLATE,
  });

  assert.equal(statsCalls, 2);
  assert.match(readme, /Go\s+\|==================================\| 10 hrs/);
  assert.match(readme, /Rust\s+\|=================\| 5 hrs/);
  assert.match(readme, /C\s+\|========\| 2 hrs 30 mins/);
});
