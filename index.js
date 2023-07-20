#!/usr/bin/env node
import fs from 'fs';
import tmp from 'tmp';
import path from 'path';
import ytpl from 'ytpl';
import ytdl from 'ytdl-core';
import express from 'express';
import { Podcast } from 'podcast';
import ffmpeg from 'fluent-ffmpeg';
import fsPromises from 'fs/promises';
import tmpPromise from 'tmp-promise';
import { moveFile } from 'move-file';

const debug = !!parseInt(process.env.DEBUG, 10);
const port = process.env.PORT || 3000;
const eplimit = process.env.EPISODE_LIMIT || 20;
const cachedir = process.env.CACHE_DIR || tmp.dirSync().name;
tmp.setGracefulCleanup();
if (!path.isAbsolute(cachedir)) {
  throw new Error('CACHE_DIR, if provided, must be absolute');
}
console.log(`youtube-podcast listening on port ${port}`);

express()
  // Just so there's something here
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

  // Generate an RSS podcast feed from a YouTube playlist ID
  .get('/feed/:id.rss', (req, res) => {
    console.log(new Date().toLocaleTimeString('en-GB') + ' ' + req.originalUrl);
    let feed;

    // Request data about the playlist
    ytpl(req.params.id, { limit: eplimit })
      .then(playlist => {
        if (debug) { console.log(JSON.stringify(playlist, null, 2)); }
        const myurl = new URL(req.originalUrl, `${req.protocol}://${req.hostname}:${port}`);
        feed = new Podcast({
          title: playlist.title,
          description: playlist.description,
          generator: 'youtube-podcast',
          feedUrl: myurl.href,    // This feed itself
          siteUrl: playlist.url,  // Include the original YouTube URL
          imageUrl: playlist.bestThumbnail.url,
          author: playlist.author.name,
          pubDate: playlist.lastUpdated,
          itunesAuthor: playlist.author.name,
          itunesSummary: playlist.description,
          itunesImage: playlist.bestThumbnail.url,
        });

        // Request further data about all the items in the playlist
        const itemPromises = playlist.items.map(item => ytdl.getInfo(item.id)
          .then(info => {
            if (debug) { console.log(JSON.stringify(info, null, 2)); }
            // Base the item URLs on that of the feed, as they are also served by this app
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
                url: itemurl.href,  // Refers to the actual audio for the episode
                type: 'audio/mpeg', // We always deliver it in MP3 here
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

  // Get an episode from the cache, if present
  .get('/item/:id.mp3', (req, res, next) => {
    console.log(new Date().toLocaleTimeString('en-GB') + ' ' + req.originalUrl);
    fsPromises.access(`${cachedir}/${req.params.id}.mp3`, fs.constants.R_OK)
      .then(() => res.sendFile(`${cachedir}/${req.params.id}.mp3`))
      .catch(e => next());

  // Otherwise, download and convert it, add it to the cache
  }, (req, res) => {
    let inPath, outPath, info, playlist;

    // Download will first be saved to a temporary file
    tmpPromise.tmpName({ postfix: '.tmp' })
      .then(tmpPath => new Promise((resolve, reject) => {
        inPath = tmpPath;
        if (debug) { console.log(inPath); }
        ytdl(req.params.id, { quality: 'highestaudio', filter: 'audioonly' })
          // Metadata is retrieved so we can tag the converted MP3
          .on('info', (videoInfo, videoFormat) => {
            info = videoInfo.videoDetails;
            if (debug) {
              console.log(JSON.stringify(videoInfo, null, 2));
              console.log(JSON.stringify(videoFormat, null, 2));
            }
          })
          // Just for logging- client doesn't see this
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

      // Get playlist metadata useful for tagging the MP3, if we have a list ID
      .then(() =>
        ytpl(req.query.list, { limit: eplimit })
          .then(ytplResult => {
            playlist = ytplResult;
            if (debug) { console.log(JSON.stringify(playlist, null, 2)); }
          })
          .catch (e => {
            playlist = {
              title: '',
              author: { name: '' },
            };
          })
      )

      // Convert from whatever format we managed to download, to MP3
      // This requires ffmpeg to be installed on the same host or container as Node
      .then(() => tmpPromise.tmpName({ postfix: '.mp3' }))
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

      // Successful download, cache it
      .then(() => moveFile(outPath, `${cachedir}/${req.params.id}.mp3`))
      .then(() => res.sendFile(`${cachedir}/${req.params.id}.mp3`))
      .then(() => fsPromises.unlink(inPath))
      .catch(e => res.status(500).type('text/plain').send(e.message));
  })
  .listen(port);
