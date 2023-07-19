#!/usr/bin/env node
const fs = require('fs');
const ytpl = require('ytpl');
const ytdl = require('ytdl-core');
const tmp = require('tmp-promise');
const express = require('express');
const { Podcast } = require('podcast');
const ffmpeg = require('fluent-ffmpeg');
const fsPromises = require('fs/promises');

const debug = !!parseInt(process.env.DEBUG, 10);
const port = process.env.PORT || 3000;
const eplimit = process.env.EPISODE_LIMIT || 20;
console.log(`youtube-podcast listening on port ${port}`);

express()
  .get('/', (req, res) => {
    res.send(
`<!DOCTYPE html>
<html lang="en">
<head>
<title>youtube-podcast</title>
</head>
<body>
Hello, I am youtube-podcast
</body>
</html>
`
    );
  })

  .get('/feed/:id.rss', (req, res) => {
    console.log(new Date().toLocaleTimeString('en-GB') + ' ' + req.originalUrl);
    let feed;

    ytpl(req.params.id, { limit: eplimit })
      .then(playlist => {
        if (debug) { console.log(JSON.stringify(playlist, null, 2)); }
        const myurl = new URL(req.originalUrl, `${req.protocol}://${req.hostname}:${port}`);
        feed = new Podcast({
          title: playlist.title,
          description: playlist.description,
          generator: 'youtube-podcast',
          feedUrl: myurl.href,
          siteUrl: playlist.url,
          imageUrl: playlist.bestThumbnail.url,
          author: playlist.author.name,
          pubDate: playlist.lastUpdated,
          itunesAuthor: playlist.author.name,
          itunesSummary: playlist.description,
          itunesImage: playlist.bestThumbnail.url,
        });

        const itemPromises = playlist.items.map(item => ytdl.getInfo(item.id)
          .then(info => {
            if (debug) { console.log(JSON.stringify(info, null, 2)); }
            const itemurl = new URL(myurl);
            itemurl.pathname = `/item/${item.id}.mp3`;
            itemurl.searchParams.set('list', playlist.id);
            return {
              title: info.videoDetails.title,
              description: info.videoDetails.description,
              url: item.url,
              guid: item.id,
              categories: [info.videoDetails.category],
              author: info.videoDetails.author.name,
              date: info.videoDetails.publishDate,
              enclosure: {
                url: itemurl.href,
                type: 'audio/mpeg',
              },
              itunesAuthor: info.videoDetails.author.name,
              itunesSummary: info.videoDetails.description,
              itunesDuration: info.videoDetails.lengthSeconds,
              itunesImage: item.bestThumbnail.url,
              itunesTitle: info.videoDetails.title,
              itunesNewFeedUrl: myurl.href,
            };
          })
        );
        return Promise.all(itemPromises);
      })

      .then(items => {
        items.forEach(itemOptions => feed.addItem(itemOptions));
        return feed.buildXml('  ');
      })
      .then(rss => res.type('text/xml').send(rss))
      .catch(e => res.status(500).type('text/plain').send(e.message));
  })

  .get('/item/:id.mp3', (req, res) => {
    console.log(new Date().toLocaleTimeString('en-GB') + ' ' + req.originalUrl);
    let inPath, outPath, info, playlist;

    tmp.tmpName({ postfix: '.tmp' })
      .then(tmpPath => new Promise((resolve, reject) => {
        inPath = tmpPath;
        if (debug) { console.log(inPath); }
        ytdl(req.params.id, { quality: 'highestaudio', filter: 'audioonly' })
          .on('info', (videoInfo, videoFormat) => {
            info = videoInfo.videoDetails;
            if (debug) {
              console.log(JSON.stringify(videoInfo, null, 2));
              console.log(JSON.stringify(videoFormat, null, 2));
            }
          })
          .on('progress', (chunkBytes, doneBytes, totalBytes) => {
            const progress = (doneBytes * 100) / totalBytes;
            if (progress % 10 < 0.05) {
              console.log(`${new Date().toLocaleTimeString('en-GB')} ${req.params.id}.mp3 (DL: ${Math.floor(progress)}%)`);
            }
          })
          .on('error', reject)
          .on('finish', resolve)
          .pipe(fs.createWriteStream(inPath));
      }))

      .then(() => ytpl(req.query.list, { limit: eplimit }))
      .then(ytplResult => {
        playlist = ytplResult;
        if (debug) { console.log(JSON.stringify(playlist, null, 2)); }
      })

      .then(() => tmp.tmpName({ postfix: '.mp3' }))
      .then(tmpPath => new Promise((resolve, reject) => {
        outPath = tmpPath;
        if (debug) { console.log(outPath); }
        ffmpeg(inPath)
          .audioCodec('libmp3lame')
          .audioBitrate(320)
          .audioChannels(2)
          .audioFrequency(44100)
          .noVideo()
          .format('mp3')
          .outputOptions(
            '-metadata', `title=${info.title}`,
            '-metadata', `artist=${info.author.name}`,
            '-metadata', `album_artist=${playlist.author.name}`,
            '-metadata', `album=${playlist.title}`,
            '-metadata', `date=${new Date(info.publishDate).getFullYear()}`,
            '-metadata', `author_url=${info.video_url}`
          )
          .on('progress', progress => {
            if (progress.percent % 10 < 1 && progress.percent > 0) {
              console.log(`${new Date().toLocaleTimeString('en-GB')} ${req.params.id}.mp3 (DL: 100% XC: ${Math.floor(progress.percent)}%)`);
            }
          })
          .on('error', reject)
          .on('end', resolve)
          .save(outPath);
      }))

      .then(() => res.sendFile(outPath))
      .then(() => fsPromises.unlink(inPath))
      .then(() => fsPromises.unlink(outPath))
      .catch(e => res.status(500).type('text/plain').send(e.message));
  })
  .listen(port);
