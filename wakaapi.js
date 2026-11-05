"use strict";

// WakaTime read endpoints: https://wakatime.com/developers
// Plugin API keys are write-only. README updates need an OAuth access token
// from https://wakatime.com/oauth, stored in the existing API_KEY / WAKA_API_KEY secret.
var resource_url_prefix = "https://wakatime.com/api/v1/users/current";

function authorizationHeader(apiKey) {
    if (apiKey.indexOf("waka_tok_") === 0) {
        return "Bearer " + apiKey;
    }
    return "Basic " + Buffer.from(apiKey).toString("base64");
}

function errorText(json) {
    if (!json || typeof json !== "object") {
        return "response did not include stats data";
    }
    if (Array.isArray(json.errors) && json.errors.length) {
        return json.errors.join("; ");
    }
    if (typeof json.error === "string" && json.error) {
        return json.error;
    }
    if (typeof json.message === "string" && json.message) {
        return json.message;
    }
    return "response did not include stats data";
}

function explainFailure(status, json) {
    var detail = errorText(json);
    if (status === 401 || status === 403) {
        return "WakaTime " + status + ": " + detail.replace(/[.\s]+$/, "") + ". " +
            "Plugin API keys are write-only and cannot read stats, summaries, or all-time totals. " +
            "Store an OAuth access token from https://wakatime.com/oauth in the WAKA_API_KEY secret.";
    }
    return "WakaTime " + status + ": " + detail;
}

function request(fetchImpl, url, authorization) {
    return fetchImpl(url, {
        headers: {
            Authorization: authorization,
            Accept: "application/json"
        }
    }).then(function (response) {
        return response.json().then(function (json) {
            return { status: response.status, json: json };
        }, function () {
            return { status: response.status, json: null };
        });
    });
}

function wakaFetch(fetchImpl, apiKey, url) {
    var primary = authorizationHeader(apiKey);
    return request(fetchImpl, url, primary).then(function (result) {
        // Personal tokens are documented both as Bearer credentials and as a
        // drop-in replacement for an API key (HTTP Basic).
        if ((result.status === 401 || result.status === 403) && primary.indexOf("Bearer ") === 0) {
            return request(fetchImpl, url, "Basic " + Buffer.from(apiKey).toString("base64"));
        }
        return result;
    });
}

function fetchStats(fetchImpl, apiKey, sleep) {
    var url = resource_url_prefix + "/stats";
    var attempt = 0;
    function once() {
        return wakaFetch(fetchImpl, apiKey, url).then(function (result) {
            if (result.status === 401 || result.status === 403) {
                throw new Error(explainFailure(result.status, result.json));
            }
            var data = result.json && result.json.data;
            if (data && data.is_up_to_date) {
                return result.json;
            }
            var retriesLeft = 3 - attempt;
            attempt += 1;
            if (retriesLeft > 0 && (data || result.status === 202 || result.status >= 500)) {
                console.log("Stats data stale, retrying... (" + retriesLeft + " left)");
                return sleep(5000).then(once);
            }
            if (data) {
                console.warn("Stats data still stale after retries, using cached data.");
                return result.json;
            }
            throw new Error(explainFailure(result.status, result.json));
        });
    }
    return once();
}

function fetchSummaries(fetchImpl, apiKey) {
    var params = new URLSearchParams();
    params.append("range", "Last 7 Days");
    var url = resource_url_prefix + "/summaries?" + params.toString();
    return wakaFetch(fetchImpl, apiKey, url).then(function (result) {
        if (!result.json || !result.json.cumulative_total || result.status === 401 || result.status === 403) {
            throw new Error(explainFailure(result.status, result.json));
        }
        return result.json;
    });
}

function fetchAllTime(fetchImpl, apiKey, sleep) {
    var url = resource_url_prefix + "/all_time_since_today";
    var attempt = 0;
    function once() {
        return wakaFetch(fetchImpl, apiKey, url).then(function (result) {
            if (result.status === 401 || result.status === 403) {
                throw new Error(explainFailure(result.status, result.json));
            }
            var text = result.json && result.json.data && result.json.data.text;
            if (text) {
                return result.json;
            }
            var retriesLeft = 3 - attempt;
            attempt += 1;
            if (retriesLeft > 0) {
                console.log("All time data empty, retrying... (" + retriesLeft + " left)");
                return sleep(5000).then(once);
            }
            console.warn("All time data still empty after retries.");
            if (result.json && result.json.data) {
                return result.json;
            }
            throw new Error(explainFailure(result.status, result.json));
        });
    }
    return once();
}

function languageDecimalHours(lang) {
    if (lang.decimal !== undefined && lang.decimal !== null && lang.decimal !== "") {
        return Number(lang.decimal);
    }
    return Number(lang.total_seconds) / 3600;
}

function topLanguages(statsJson) {
    var languages = statsJson.data && statsJson.data.languages;
    if (!languages || !languages.length) {
        throw new Error("WakaTime stats response did not include languages");
    }
    var count = Math.min(3, languages.length);
    var top = [];
    var maxNameLen = 0;
    var maxHrs = NaN;
    for (var i = 0; i < count; i++) {
        var lang = languages[i];
        var hrs = languageDecimalHours(lang);
        if (!i) {
            maxHrs = hrs;
        }
        maxNameLen = Math.max(maxNameLen, lang.name.length);
        top.push({
            name: lang.name,
            progress_bar_len: Math.floor(hrs / maxHrs * 34),
            hrs: lang.text
        });
    }
    return { top: top, maxNameLen: maxNameLen };
}

function renderLanguages(top, maxNameLen) {
    var field = "";
    for (var i = 0; i < top.length; i++) {
        var name = top[i].name;
        var nameField = name + " ".repeat(maxNameLen - name.length);
        var bar = "|" + "=".repeat(top[i].progress_bar_len) + "|";
        field += " ".repeat(12) + nameField + " " + bar + " " + top[i].hrs + (i !== top.length - 1 ? "\n\n" : "\n");
    }
    return field;
}

function renderReadme(template, fields) {
    return template
        .replace("${UPDATE_TIME}", fields.updateTime)
        .replace("${TOTAL_TIME}", fields.totalTime ? fields.totalTime : "")
        .replace("${LAST_7_DAYS}", fields.last7Days ? fields.last7Days : "")
        .replace("${TOP_3_LANGUAGES}", fields.topLanguages);
}

function collectWaka(options) {
    var apiKey = options.apiKey;
    var fetchImpl = options.fetchImpl;
    var sleep = options.sleep;
    return Promise.all([
        fetchStats(fetchImpl, apiKey, sleep),
        fetchSummaries(fetchImpl, apiKey),
        fetchAllTime(fetchImpl, apiKey, sleep)
    ]).then(function (results) {
        var ranked = topLanguages(results[0]);
        return renderReadme(options.template, {
            updateTime: options.now(),
            totalTime: results[2].data.text,
            last7Days: results[1].cumulative_total.text,
            topLanguages: renderLanguages(ranked.top, ranked.maxNameLen)
        });
    });
}

function main() {
    var apiKey = process.env.API_KEY;
    if (!apiKey) {
        console.error("API_KEY is empty, please check your environment variable");
        process.exit(1);
    }
    var fetch = require("node-fetch");
    var moment = require("moment-timezone");
    var fs = require("fs");
    return fs.promises.readFile("./README_template.md", "utf-8").then(function (template) {
        return collectWaka({
            apiKey: apiKey,
            fetchImpl: fetch,
            sleep: function (ms) {
                return new Promise(function (resolve) {
                    setTimeout(resolve, ms);
                });
            },
            now: function () {
                return moment().tz("Asia/Shanghai").format("YYYY-MM-DD, HH:mm:ss");
            },
            template: template
        });
    }).then(function (readme) {
        return fs.promises.writeFile("./README.md", readme);
    });
}

if (require.main === module) {
    main().catch(function (err) {
        console.error(err && err.message ? err.message : err);
        process.exit(1);
    });
}

module.exports = {
    authorizationHeader: authorizationHeader,
    collectWaka: collectWaka
};
