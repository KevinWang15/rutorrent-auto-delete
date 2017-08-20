let express = require('express');
let config = require('./config');
let request = require('request').defaults({ 'proxy': config.proxy || null });
let fs = require('fs');
let et = require('elementtree');

let Queue = require('promise-queue');
let urlJoin = require('url-join');
let maxConcurrentHttpRequests = config.maxConcurrentHttpRequests || 8;
let queue = new Queue(maxConcurrentHttpRequests);

let deleteTorrentXmlCommandTemplate = require('./xml-command-template');

// refer to https://github.com/Novik/ruTorrent/blob/master/plugins/httprpc/action.php#L91-L97
const NAME_ARRAY_INDEX = 4, SIZE_ARRAY_INDEX = 5, RATIO_ARRAY_INDEX = 10, UPRATE_ARRAY_INDEX = 11,
    DOWNRATE_ARRAY_INDEX = 12;

function doOperation() {
    let statsUrl = urlJoin(config.url, 'plugins/diskspace/action.php');
    request.get(statsUrl, function (error, response, body) {
        if (error) {
            console.warn("Fetching " + statsUrl + " has failed, " + JSON.stringify(error));
            return;
        }
        try {
            let result = (JSON.parse(body));
            let ratio = (result.total - result.free) / result.total;
            let neededBytes = (result.total - result.free) - result.total * config.ratio;
            if (ratio > config.ratio) {
                // need to free up space
                console.log("Current ratio is " + ratio.toFixed(2) + " need to free up " + (neededBytes / 1024 / 1024 / 1024).toFixed(1) + " GB");
                request.post(urlJoin(config.url, 'plugins/httprpc/action.php'),
                    { form: { mode: "list" } },
                    function (error, response, body) {
                        let raw_data = JSON.parse(body).t;
                        let data = [];
                        let age = 0;
                        for (let key in raw_data) {
                            if (!raw_data.hasOwnProperty(key)) continue;

                            // exempt downloading torrents
                            if (+raw_data[key][DOWNRATE_ARRAY_INDEX]) continue;
                            data.push({
                                // old torrents come first
                                age: age--,
                                hash: key,
                                name: raw_data[key][NAME_ARRAY_INDEX],
                                up_rate: +raw_data[key][UPRATE_ARRAY_INDEX],
                                down_rate: +raw_data[key][DOWNRATE_ARRAY_INDEX],
                                ratio: +raw_data[key][RATIO_ARRAY_INDEX],
                                size: +raw_data[key][SIZE_ARRAY_INDEX],
                            });
                        }
                        data.sort((a, b) => {
                            if (a.up_rate !== b.up_rate) {
                                return a.up_rate - b.up_rate;
                            } else {
                                return b.age - a.age;
                            }
                        });

                        let fulfilledBytes = 0;
                        let i = 0;
                        let toDelete = [];
                        while (fulfilledBytes < neededBytes) {
                            fulfilledBytes += data[i].size;
                            toDelete.push({
                                hash: data[i].hash,
                                name: data[i].name,
                                size: data[i].size,
                            });
                            i++;
                        }
                        console.log("Deleting " + toDelete.length + " files (to free up " + (fulfilledBytes / 1024 / 1024 / 1024).toFixed(1) + " GB)");
                        toDelete.forEach((item) => {
                            queue.add(() => {
                                return new Promise((queue_res) => {
                                    console.log("- Deleting " + item.name + " (" + (item.size / 1024 / 1024 / 1024).toFixed(1) + " GB)");
                                    request.post(
                                        {
                                            url: urlJoin(config.url, 'plugins/httprpc/action.php'),
                                            body: deleteTorrentXmlCommandTemplate(item.hash),
                                            headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
                                        },
                                        function (error, response, body) {
                                            console.log(error);
                                            console.log(body);
                                            queue_res();
                                        }).auth(config.basic_auth_username, config.basic_auth_password);
                                });
                            });
                        });
                    }).auth(config.basic_auth_username, config.basic_auth_password);
            } else {
                console.log("Current ratio is " + ratio.toFixed(2) + ", you can still add " + ((result.free - result.total * config.ratio) / 1024 / 1024 / 1024).toFixed(1) + " GB of data");
            }
        } catch (error) {
            console.warn(JSON.stringify(error));
        }
    }).auth(config.basic_auth_username, config.basic_auth_password);
}

doOperation();
setInterval(doOperation, config.interval * 1000);