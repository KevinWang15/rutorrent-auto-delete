module.exports = {
    // check interval in seconds
    interval: 180,

    // front end url for rutorrent
    url: "https://my.example.com/pt",

    // delete old torrents and free up space when used space exceeds the following ratio
    ratio: 0.8,

    // delete all torrents with share ratio more than the following first, when freeing up space. Set to 0 to disable
    maxShareRatio: 0,

    // leave empty if not using basic auth
    basic_auth_username: "",
    basic_auth_password: "",

    maxConcurrentHttpRequests: 8
};