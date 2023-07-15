#!/usr/bin/env node
const ytpl = require('ytpl');
const ytdl = require('ytdl-core');
const express = require('express');
const { Podcast } = require('podcast');

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
    console.log(req.originalUrl);
    let feed;

    ytpl(req.params.id, { limit: eplimit })
      .then(playlist => {
        // console.log(JSON.stringify(playlist, null, 2)); // DEBUG
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
            // console.log(JSON.stringify(info, null, 2)); // DEBUG
            const format = ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' });
            return {
              title: info.videoDetails.title,
              description: info.videoDetails.description,
              url: item.url,
              guid: item.id,
              categories: [info.videoDetails.category],
              author: info.videoDetails.author.name,
              date: info.videoDetails.publishDate,
              enclosure: {
                url: format.url,
                size: format.contentLength,
                type: format.mimeType,
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
  .listen(port);
