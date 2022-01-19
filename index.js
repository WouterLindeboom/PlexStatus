const { Transmission } = require('@ctrl/transmission')
const { Client, Intents, MessageEmbed, MessageActionRow, MessageButton } = require('discord.js')
const moment = require('moment');
const SonarrAPI = require('sonarr-api')
require("moment-duration-format");
moment().format();

const dclient = new Client({ intents: [Intents.FLAGS.GUILD_MESSAGES] });
const configFile = require('./config.json');
const dcfg = configFile.discord;
const tcfg = configFile.transmission;
const scfg = configFile.sonarr;
const ccfg = configFile.colours;

const strings = require('./strings.json')
const tstr = strings.deadTorrents;

var stalledDownloads = {};

dclient.login(dcfg.token)

const tclient = new Transmission({
    baseUrl: tcfg.host,
    path: tcfg.path,
    username: tcfg.username,
    password: tcfg.password
});

const sonarr = new SonarrAPI({
    hostname: scfg.hostname,
    apiKey: scfg.apikey,
    port: scfg.port
})

const reportButtons = new MessageActionRow()
    .addComponents(
        new MessageButton()
            .setCustomId('approve')
            .setLabel('Approve & ignore')
            .setEmoji('849413470671732747')
            .setStyle('SUCCESS'),
        new MessageButton()
            .setCustomId('remove')
            .setLabel('Remove & replace')
            .setEmoji('849413470905827328')
            .setStyle('DANGER'),
        new MessageButton()
            .setCustomId('reset')
            .setLabel('Reset penalty score')
            .setEmoji('🔁')
            .setStyle('PRIMARY')
    );

dclient.on('ready', () => {
    console.log(`Discord ready`);
    setInterval(timer, 30000)
    timer();
})

dclient.on('messageCreate', msg => {
    if(msg.author)
    parsemessage(msg)
})

dclient.on('interactionCreate', interaction => {
    if (!interaction.isButton()) return;
    if(interaction.channelId == dcfg.adminchannelid) deadTorrentInteraction(interaction);
})

function deadTorrentInteraction(i){
    const message = i.message;
    const torrentId = message.embeds[0].fields.find( ({ name }) => name === 'ID').value;
    fetchTorrents()
        .then(torrents => {
            verifyTorrentsObject(torrents, torrentId)
                .then((result)=>{
                    if(result){
                        updateTorrentReport(i, true);
                    } else {
                        switch (i.customId) {
                            case "approve":
                                updateTorrentReport(i);
                                break;
                            case "remove":
                                updateTorrentReport(i);
                                break;
                            case "reset":
                                stalledDownloads[torrentId] = 0;
                                updateTorrentReport(i);
                                break;
                        }
                    }
            })
        }); 
}

function updateTorrentReport(i, removed = false){
    const oldEmbed = i.message.embeds[0];
    const updatedEmbed = new MessageEmbed(oldEmbed)
        .setColor(ccfg[i.customId])
    if(removed){
        updatedEmbed.addField("Torrent does not exist", tstr.notexist);
        updatedEmbed.setColor(ccfg.notexist);
        i.reply({embeds: [buildTorrentReplyEmbed("notexist").setTitle("Error!")], ephemeral: true})
    } else {
        updatedEmbed.addField("Action taken", `__${tstr[i.customId]}__`)
        i.reply({embeds: [buildTorrentReplyEmbed(i.customId)], ephemeral: true})
    }
    i.message.edit({ embeds: [updatedEmbed], components: [] })
    // i.reply({embeds: [buildTorrentReplyEmbed(i.customId)], ephemeral: true})
}

function parsemessage(msg) {
    if(msg.author.id !== dcfg.downy) return
    if(msg.content == "!fetch"){

    }
    if(msg.content == "!gen"){
        fetchTorrents()
            .then(result => {
                msg.channel.send(buildEmbed(result));
            })
    }
    if(msg.content == "!test"){
        dclient.channels.cache.get(dcfg.channelid).messages.fetch(dcfg.dlmessageid)
            .then(message => console.log(message))
    }
    if(msg.content == "!update"){
        sonarr.get("diskspace")
            .then(diskdata => {
                dclient.channels.cache.get(dcfg.testchannelid).messages.fetch(dcfg.diskmessageid)
                    .then(message => updateDisk(diskdata, message));
        });
    }

}

function timer(){
    //Download status
    fetchTorrents()
        .then(torrents => {
            verifyTorrentsObject(torrents)
                .then(()=>{
                    determineTorrentHealth(torrents);
                    reportDeadTorrent(); //Check list of torrents with penalties, report if high enough
                    dclient.channels.fetch(dcfg.channelid)
                        .then(channel => {
                            channel.messages.fetch(dcfg.dlmessageid)
                                .then(message => updateStatus(torrents, message));
                        })
                    
                })
    });
    //Disk status
    sonarr.get("diskspace")
        .then(diskdata => {
            dclient.channels.fetch(dcfg.channelid)
                .then(channel => {
                    channel.messages.fetch(dcfg.diskmessageid)
                        .then(message => updateDisk(diskdata, message));
                })
            
    });
}

async function getTorrentIds(torrents){
    let ids = [];
    for(let i in torrents){
        ids.push(torrents[i].id)
    }
    return ids;
}

async function verifyTorrentsObject(torrents, id = 0){//Check if our list of torrents is still correct compared to the torrents in Transmission
    let entries = Object.entries(stalledDownloads);
    let ids = await getTorrentIds(torrents);
    for(let i in entries){
        if(!ids.includes(parseInt(entries[i][0]))){
            console.log(`Torrent ID ${entries[i][0]} does not exist anymore, deleting`);    
            delete stalledDownloads[entries[i][0]];//Delete removed torrent from object
            if(entries[i][0] == id){//Check for a specific ID in the list, return true if deleted
                return true;
            }
        }
    }
    return false;
}

function reportDeadTorrent(){//Report if a torrent has a score of 20(?), then blacklist it
    let downloads = Object.entries(stalledDownloads);
    for(let j in downloads){//Check if we have any torrents with breaking score
        if(downloads[j][1] == tcfg.maxPenalties){//Yup
            fetchTorrent(parseInt(downloads[j][0]))
                .then(torrent => {
                    dclient.channels.fetch(dcfg.adminchannelid)
                        .then(channel => {
                            downloads[j][1]++;
                            channel.send({embeds:[buildDeadTorrentEmbed(torrent)], components: [reportButtons]})
                        })
                    
                })
        }
    }
}

function determineTorrentHealth(torrents){//Find & report stalled downloads
    for(let i in torrents){
        if(torrents[i].eta.toString().startsWith('-')){//Torrent has a negative ETA
            if (torrents[i].id in stalledDownloads) {//Add penalty point to dead torrent object
                stalledDownloads[torrents[i].id]++;
            } else {
                stalledDownloads[torrents[i].id] = 1;
            };
        }
    }
};

async function fetchTorrent(id){
    const data = await tclient.getTorrent(id);
    return data;
}

async function fetchTorrents(){
    let res = await tclient.getAllData();
    return res.torrents;
}

function buildEmbed(td){
    const statusEmbed = new MessageEmbed()
        .setColor('#e5a00d')
        .setTitle('Download Status')
        .setURL(dcfg.plexurl)
        .setTimestamp()
        .setFooter('Downcorp Plex Download Status')

    for(const i in td) {
        let progress = Math.round(td[i].progress*100)
        let downloading = td[i].downloadSpeed > 0 ? "⬇️" : "⏸️"
        let timeleft = moment.duration(td[i].eta, "seconds").format("hh:mm:ss")
        let eta = td[i].eta.toString();
        if(eta.startsWith('-')) timeleft = "---"
        statusEmbed.addField(`${downloading} `+td[i].name, `Progress: **${progress}%**\nTime Left: **${timeleft}**`, true);
    }
    if(td.length == 0){
        statusEmbed.addField("**All done!**", "<:PeepoSalute:690379861612560394>")
    }
    return statusEmbed;


}

function buildDiskEmbed(data){
    const names = ["System", "Drive 1", "Drive 2", "Drive 3", "Drive 4", "Drive 5"];
    const diskEmbed = new MessageEmbed()
        .setColor('#e5a00d')
        .setTitle('Disk Status')
        .setURL(dcfg.plexurl)
        .setTimestamp()
        .setFooter('Downcorp Plex Disk Status')

        for(const i in data) {
            let fgb = Math.round(data[i].freeSpace/1073741824);
            let tgb = Math.round(data[i].totalSpace/1073741824);
            let used = Math.round(tgb-fgb);
            diskEmbed.addField(names[i], `Free: **${fgb}** GB / **${tgb}** GB`, false);
        }
    return diskEmbed;
};

function buildDeadTorrentEmbed(data){
    const deadTorrentEmbed = new MessageEmbed()
        .setColor('#ff8200')
        .setTitle('Dead torrent')
        .setURL(`http://${tcfg.host}`)
        .setTimestamp()
        .setFooter('Downcorp Plex Torrent Reporter')
        .setDescription("I think I've detected a dead torrent, please verify")
        .addField("Name", "```"+data.name+"```")
        .addField("Progress", Math.round(data.progress*100)+"%", true)
        .addField("Added", moment(data.dateAdded).fromNow(), true)
        .addField("ID", data.id.toString(), true)
    return deadTorrentEmbed;
};

function buildTorrentReplyEmbed(data){
    const torrentReplyEmbed = new MessageEmbed()
        .setTitle('Done!')
        .setColor(ccfg[data])
        .setDescription(tstr[data])
    return torrentReplyEmbed;
}

function updateDisk(diskdata, msg){
    msg.edit({embeds:[buildDiskEmbed(diskdata)]});
};

function updateStatus(torrentdata, msg){
    msg.edit({embeds:[buildEmbed(torrentdata)]});
};











//
