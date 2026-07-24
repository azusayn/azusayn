"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var moment = require("moment-timezone");
var fs = require("fs");
const fetch = require('node-fetch')

// refer to wakatime api documentation when needed: https://wakatime.com/developers
var resource_url_prefix = 'https://wakatime.com/api/v1/users/current';
// prepare base64-encoded api_key for authntication
var API_KEY = process.env.API_KEY; // set your API key in certain github repository
if (!API_KEY) {
    console.error('API_KEY is empty, please check your environment variable');
    process.exit(1);
}
var api_key_b64_encoded = Buffer.from(API_KEY).toString('base64');
var top_3 = [];
var max_lang_name_len = 0;
var time_total = null;
var time_7_days = null;
// top 3 languages
var p0 = fetch("".concat(resource_url_prefix, "/stats"), {
    headers: {
        'Authorization': "Basic ".concat(api_key_b64_encoded)
    }
}).then(function (resp) { return resp.json(); }).then(function (json) {
    var retries = 3;
    function try_stats(n) {
        return new Promise(function (resolve, reject) {
            if (json['data']['is_up_to_date']) {
                resolve(json);
            } else if (n > 0) {
                console.log("Stats data stale, retrying... (".concat(n, " left)"));
                setTimeout(function () {
                    fetch("".concat(resource_url_prefix, "/stats"), {
                        headers: {
                            'Authorization': "Basic ".concat(api_key_b64_encoded)
                        }
                    }).then(function (resp) { return resp.json(); }).then(function (j) {
                        json = j;
                        try_stats(n - 1).then(resolve);
                    });
                }, 5000);
            } else {
                console.warn("Stats data still stale after retries, using cached data.");
                resolve(json);
            }
        });
    }
    return try_stats(retries).then(function () {
        var max_hrs = NaN;
        for (var i = 0; i < 3; i++) {
            var lang_json = json['data']['languages'][i];
            if (!i) {
                max_hrs = Number(lang_json['decimal']);
            }
            max_lang_name_len = Math.max(max_lang_name_len, lang_json['name'].length);
            top_3.push({
                name: lang_json['name'],
                progress_bar_len: Math.floor(Number(lang_json['decimal']) / max_hrs * 34),
                hrs: lang_json['text']
            });
        }
    });
});
// total coding time over last 7 days
var params = new URLSearchParams();
params.append('range', 'Last 7 Days');
var p1 = fetch("".concat(resource_url_prefix, "/summaries?").concat(params.toString()), {
    headers: {
        'Authorization': "Basic ".concat(api_key_b64_encoded)
    },
}).then(function (resp) { return resp.json(); }).then(function (json) {
    time_7_days = json['cumulative_total']['text'];
});
// total time spent with wakatime
var p2 = fetch("".concat(resource_url_prefix, "/all_time_since_today"), {
    headers: {
        'Authorization': "Basic ".concat(api_key_b64_encoded)
    },
}).then(function (resp) { return resp.json(); }).then(function (json) {
    time_total = json['data']['text'];
}).then(function () {
    var retries = 3;
    function try_all_time(n) {
        return new Promise(function (resolve, reject) {
            if (time_total) {
                resolve();
            } else if (n > 0) {
                console.log("All time data empty, retrying... (".concat(n, " left)"));
                setTimeout(function () {
                    fetch("".concat(resource_url_prefix, "/all_time_since_today"), {
                        headers: {
                            'Authorization': "Basic ".concat(api_key_b64_encoded)
                        }
                    }).then(function (resp) { return resp.json(); }).then(function (json) {
                        time_total = json['data']['text'];
                        try_all_time(n - 1).then(resolve);
                    });
                }, 5000);
            } else {
                console.warn("All time data still empty after retries.");
                resolve();
            }
        });
    }
    return try_all_time(retries);
});
// save results to README.md
Promise.all([p0, p1, p2]).then(function () {
    fs.readFile('./README_template.md', 'utf-8', function (err, data) {
        data = data.replace('${UPDATE_TIME}', moment().tz("Asia/Shanghai").format('YYYY-MM-DD, HH:mm:ss')).replace('${TOTAL_TIME}', time_total ? time_total : '').replace('${LAST_7_DAYS}', time_7_days ? time_7_days : '');
        var top_lang_field = '';
        for (var i = 0; i < top_3.length; i++) {
            var lang_name = top_3[i].name;
            var lang_name_field = "".concat(lang_name).concat(' '.repeat(max_lang_name_len - lang_name.length));
            var progress_bar_field = "|".concat('='.repeat(top_3[i].progress_bar_len), "|");
            var hrs_field = top_3[i].hrs;
            top_lang_field +=
                "".concat(' '.repeat(12)).concat(lang_name_field, " ").concat(progress_bar_field, " ").concat(hrs_field).concat(i != 2 ? '\n\n' : '\n');
        }
        data = data.replace('${TOP_3_LANGUAGES}', top_lang_field);
        fs.writeFile('./README.md', data, function (err) { });
    });
});
