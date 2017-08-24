let config = require('./config');
let request = require('request').defaults({ 'proxy': config.proxy || null });
let fs = require('fs');
let Queue = require('promise-queue');
let urlJoin = require('url-join');
let maxConcurrentHttpRequests = config.maxConcurrentHttpRequests || 8;
let queue = new Queue(maxConcurrentHttpRequests);

let deleteTorrentXmlCommandTemplate = require('./xml-command-template');

// refer to https://github.com/Novik/ruTorrent/blob/master/plugins/httprpc/action.php#L91-L97
const ARRAY_INDEX = {
    name: 4,
    size: 5,
    done_size: 8,
    up_total: 9,
    ratio: 10,
    up_rate: 11,
    down_rate: 12,
    tag: 14,
};

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
                console.log("Current ratio is " + ratio.toFixed(2) + " (" + ((result.total - result.free) / 1024 / 1024 / 1024).toFixed(1) + " GB" + " / " + (result.total / 1024 / 1024 / 1024).toFixed(1) + " GB" + ") need to free up " + (neededBytes / 1024 / 1024 / 1024).toFixed(1) + " GB");
            } else {
                console.log("Current ratio is " + ratio.toFixed(2) + " (" + ((result.total - result.free) / 1024 / 1024 / 1024).toFixed(1) + " GB" + " / " + (result.total / 1024 / 1024 / 1024).toFixed(1) + " GB" + "), you can still add " + ((result.total * config.ratio - (result.total - result.free)) / 1024 / 1024 / 1024).toFixed(1) + " GB of data");
            }
            request.post(urlJoin(config.url, 'plugins/httprpc/action.php'),
                { form: 'mode=list&cmd=d.custom%3Dseedingtime&cmd=d.custom%3Daddtime' },
                function (error, response, body) {
                    let parsedData = {};
                    let innocentTorrents = [];
                    let fulfilledBytes = 0;
                    let toDelete = [];
                    let age = 0;
                    let totalSize = 0;
                    let totalDoneSize = 0;

                    // Defining util function in scope
                    function deleteTorrent(key) {
                        if (config.newTorrentsTTL) {
                            if (parsedData[key].addTime && parsedData[key].addTime < config.newTorrentsTTL) {
                                console.log("Exempting new torrent: " + parsedData[key].name + ", which is only " + parsedData[key].addTime + " secs old.");
                                return;
                            }
                        }
                        fulfilledBytes += +parsedData[key].size;
                        toDelete.push({
                            hash: key,
                            name: parsedData[key].name,
                            size: parsedData[key].size,
                        });
                    }

                    // Parsing Data, giving us parsedData
                    try {
                        let raw_data = JSON.parse(body).t;
                        for (let key in raw_data) {
                            if (!raw_data.hasOwnProperty(key)) continue;
                            parsedData[key] = {
                                // old torrents come first
                                age: age--,
                                hash: key,
                                name: raw_data[key][ARRAY_INDEX.name],
                                up_rate: +raw_data[key][ARRAY_INDEX.up_rate],
                                down_rate: +raw_data[key][ARRAY_INDEX.down_rate],
                                ratio: +raw_data[key][ARRAY_INDEX.ratio],
                                size: +raw_data[key][ARRAY_INDEX.size],
                                done_size: +raw_data[key][ARRAY_INDEX.done_size],
                                seedTime: parseTime(raw_data[key][raw_data[key].length - 2]),
                                addTime: parseTime(raw_data[key][raw_data[key].length - 1]),
                                tag: raw_data[key][ARRAY_INDEX.tag],
                                up_total: raw_data[key][ARRAY_INDEX.up_total],
                            };
                        }
                    } catch (e) {
                        console.error(e);
                        return;
                    }

                    // Determine which torrents to delete
                    // ==================================================
                    // delete guilty torrents first (those exceeding maxSeedTime/maxShareRatio)
                    for (let key in parsedData) {
                        if (!parsedData.hasOwnProperty(key)) continue;
                        totalSize += +parsedData[key].size;
                        totalDoneSize += +parsedData[key].done_size;

                        // exempt torrents with keepTag
                        if (config.keepTag && parsedData[key].tag === config.keepTag) continue;

                        // downloading torrents
                        if (+parsedData[key].down_rate) {
                            if (config.maxShareRatio) {
                                if (parsedData[key].up_total >= parsedData[key].size * config.maxShareRatio) {
                                    deleteTorrent(key);
                                } else {
                                    continue;
                                }
                            } else {
                                continue;
                            }
                        }

                        // non-downloading torrents
                        // delete torrents with very high share ratio first, according to config file
                        if (config.maxShareRatio && +parsedData[key].ratio > config.maxShareRatio * 1000) {
                            deleteTorrent(key);
                            continue;
                        }


                        if (config.maxSeedTime && parsedData[key].seedTime > config.maxSeedTime) {
                            deleteTorrent(key);
                            continue;
                        }

                        innocentTorrents.push(parsedData[key]);
                    }

                    // sort innocent torrents by up_rate, then age
                    innocentTorrents.sort((a, b) => {
                        if (a.up_rate !== b.up_rate) {
                            return a.up_rate - b.up_rate;
                        } else {
                            return b.age - a.age;
                        }
                    });

                    console.log("Total size of torrents " + (totalDoneSize / 1024 / 1024 / 1024).toFixed(1) + " GB" + " / " + (totalSize / 1024 / 1024 / 1024).toFixed(1) + " GB");

                    // delete innocent torrents until there is enough space
                    let i = 0;
                    while (fulfilledBytes < neededBytes) {
                        if (i >= innocentTorrents.length) {
                            console.log("\n!!! Error: cannot free up more than " + (fulfilledBytes / 1024 / 1024 / 1024).toFixed(1) + " GB !!!\n");
                            break;
                        }
                        deleteTorrent(innocentTorrents[i].hash);
                        i++;
                    }
                    if (!toDelete.length) return;

                    // carry out the deletion
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
                                    function (error) {
                                        if (error) console.error(JSON.stringify(error));
                                        queue_res();
                                    }).auth(config.basicAuthUsername, config.basicAuthPassword);
                            });
                        });
                    });
                }).auth(config.basicAuthUsername, config.basicAuthPassword);
        } catch (error) {
            console.warn(JSON.stringify(error));
        }
    }).auth(config.basicAuthUsername, config.basicAuthPassword);
}

// support self-signed ssl certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
doOperation();
setInterval(doOperation, config.interval * 1000);

function parseTime(seedTime) {
    seedTime = seedTime.replace(/\s/g, '');
    if (!seedTime) return 0;
    return Math.floor(+new Date() / 1000) - seedTime;
}