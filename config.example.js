module.exports = {
    // check interval in seconds
    interval: 180,

    // front end url for rutorrent
    url: "https://my.example.com/pt",

    // delete old torrents and free up space when used space exceeds the following ratio
    ratio: 0.8,

    // When freeing up space, delete all torrents with a share ratio higher than 10 first (set to 0 to disable)
    // (criterion: when UploadedSize >= 10 * TotalSize, affects downloading torrents too)
    maxShareRatio: 10,

    // ignore (do not delete) all torrents with tag "keep" set
    keepTag: "keep",

    // leave empty if not using basic auth
    basicAuthUsername: "",
    basicAuthPassword: "",

    maxConcurrentHttpRequests: 8,
};