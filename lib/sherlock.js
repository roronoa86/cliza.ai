// lib/sherlock.js
// OSINT username search — Node.js murni, tanpa Python.
// Data dari sherlock-project/sherlock (481 platform).
// Kompatibel Railway/Replit/VPS tanpa instalasi tambahan.

'use strict';

const axios = require('axios');

// 481 platform dari sherlock-project/sherlock
const SITES = [
  {
    "name": "1337x",
    "uri": "https://www.1337x.to/user/{username}/",
    "error_type": "message",
    "error_msg": "<title>Error something went wrong.</title>",
    "regex": "^[A-Za-z0-9]{4,12}$"
  },
  {
    "name": "2Dimensions",
    "uri": "https://2Dimensions.com/a/{username}",
    "error_type": "status_code"
  },
  {
    "name": "7Cups",
    "uri": "https://www.7cups.com/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "9GAG",
    "uri": "https://www.9gag.com/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "APClips",
    "uri": "https://apclips.com/{username}",
    "error_type": "message",
    "error_msg": "Amateur Porn Content Creators"
  },
  {
    "name": "About.me",
    "uri": "https://about.me/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Academia.edu",
    "uri": "https://independent.academia.edu/{username}",
    "error_type": "status_code",
    "regex": "^[^.]*$"
  },
  {
    "name": "AdmireMe.Vip",
    "uri": "https://admireme.vip/{username}",
    "error_type": "message",
    "error_msg": "Page Not Found"
  },
  {
    "name": "Airbit",
    "uri": "https://airbit.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Airliners",
    "uri": "https://www.airliners.net/user/{username}/profile/photos",
    "error_type": "status_code"
  },
  {
    "name": "All Things Worn",
    "uri": "https://www.allthingsworn.com/profile/{username}",
    "error_type": "message",
    "error_msg": "Sell Used Panties"
  },
  {
    "name": "AllMyLinks",
    "uri": "https://allmylinks.com/{username}",
    "error_type": "message",
    "error_msg": "Page not found",
    "regex": "^[a-z0-9][a-z0-9-]{2,32}$"
  },
  {
    "name": "AniWorld",
    "uri": "https://aniworld.to/user/profil/{username}",
    "error_type": "message",
    "error_msg": "Dieses Profil ist nicht verfügbar"
  },
  {
    "name": "Anilist",
    "uri": "https://anilist.co/user/{username}/",
    "error_type": "status_code",
    "regex": "^[A-Za-z0-9]{2,20}$"
  },
  {
    "name": "Apple Developer",
    "uri": "https://developer.apple.com/forums/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Apple Discussions",
    "uri": "https://discussions.apple.com/profile/{username}",
    "error_type": "message",
    "error_msg": "Looking for something in Apple Support Communities?"
  },
  {
    "name": "Aparat",
    "uri": "https://www.aparat.com/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "Archive of Our Own",
    "uri": "https://archiveofourown.org/users/{username}",
    "error_type": "status_code",
    "regex": "^[^.]*?$"
  },
  {
    "name": "Archive.org",
    "uri": "https://archive.org/details/@{username}",
    "error_type": "message",
    "error_msg": "could not fetch an account with user item identifier"
  },
  {
    "name": "Arduino Forum",
    "uri": "https://forum.arduino.cc/u/{username}/summary",
    "error_type": "status_code"
  },
  {
    "name": "ArtStation",
    "uri": "https://www.artstation.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Asciinema",
    "uri": "https://asciinema.org/~{username}",
    "error_type": "status_code"
  },
  {
    "name": "Ask Fedora",
    "uri": "https://ask.fedoraproject.org/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Atcoder",
    "uri": "https://atcoder.jp/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Vjudge",
    "uri": "https://VJudge.net/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Audiojungle",
    "uri": "https://audiojungle.net/user/{username}",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9_]+$"
  },
  {
    "name": "Autofrage",
    "uri": "https://www.autofrage.net/nutzer/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Avizo",
    "uri": "https://www.avizo.cz/{username}/",
    "error_type": "response_url"
  },
  {
    "name": "AWS Skills Profile",
    "uri": "https://skillsprofile.skillbuilder.aws/user/{username}/",
    "error_type": "message",
    "error_msg": "shareProfileAccepted\":false"
  },
  {
    "name": "BOOTH",
    "uri": "https://{username}.booth.pm/",
    "error_type": "response_url",
    "regex": "^[\\w@-]+?$"
  },
  {
    "name": "Bandcamp",
    "uri": "https://www.bandcamp.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Bazar.cz",
    "uri": "https://www.bazar.cz/{username}/",
    "error_type": "response_url"
  },
  {
    "name": "Behance",
    "uri": "https://www.behance.net/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Bezuzyteczna",
    "uri": "https://bezuzyteczna.pl/uzytkownicy/{username}",
    "error_type": "status_code"
  },
  {
    "name": "BiggerPockets",
    "uri": "https://www.biggerpockets.com/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "BioHacking",
    "uri": "https://forum.dangerousthings.com/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "BitBucket",
    "uri": "https://bitbucket.org/{username}/",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9-_]{1,30}$"
  },
  {
    "name": "Bitwarden Forum",
    "uri": "https://community.bitwarden.com/u/{username}/summary",
    "error_type": "status_code",
    "regex": "^(?![.-])[a-zA-Z0-9_.-]{3,20}$"
  },
  {
    "name": "Blipfoto",
    "uri": "https://www.blipfoto.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Blitz Tactics",
    "uri": "https://blitztactics.com/{username}",
    "error_type": "message",
    "error_msg": "That page doesn't exist"
  },
  {
    "name": "Blogger",
    "uri": "https://{username}.blogspot.com",
    "error_type": "status_code",
    "regex": "^[a-zA-Z][a-zA-Z0-9_-]*$"
  },
  {
    "name": "Bluesky",
    "uri": "https://bsky.app/profile/{username}.bsky.social",
    "error_type": "status_code"
  },
  {
    "name": "BongaCams",
    "uri": "https://pt.bongacams.com/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Bookcrossing",
    "uri": "https://www.bookcrossing.com/mybookshelf/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "BoardGameGeek",
    "uri": "https://boardgamegeek.com/user/{username}",
    "error_type": "message",
    "error_msg": "\"isValid\":true"
  },
  {
    "name": "BraveCommunity",
    "uri": "https://community.brave.com/u/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "BreachSta.rs Forum",
    "uri": "https://breachsta.rs/profile/{username}",
    "error_type": "message",
    "error_msg": "<title>Error - BreachStars</title>"
  },
  {
    "name": "BugCrowd",
    "uri": "https://bugcrowd.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "BuyMeACoffee",
    "uri": "https://buymeacoff.ee/{username}",
    "error_type": "status_code",
    "regex": "[a-zA-Z0-9]{3,15}"
  },
  {
    "name": "BuzzFeed",
    "uri": "https://buzzfeed.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Cfx.re Forum",
    "uri": "https://forum.cfx.re/u/{username}/summary",
    "error_type": "status_code"
  },
  {
    "name": "CGTrader",
    "uri": "https://www.cgtrader.com/{username}",
    "error_type": "status_code",
    "regex": "^[^.]*?$"
  },
  {
    "name": "CNET",
    "uri": "https://www.cnet.com/profiles/{username}/",
    "error_type": "status_code",
    "regex": "^[a-z].*$"
  },
  {
    "name": "CSSBattle",
    "uri": "https://cssbattle.dev/player/{username}",
    "error_type": "status_code"
  },
  {
    "name": "CTAN",
    "uri": "https://ctan.org/author/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Caddy Community",
    "uri": "https://caddy.community/u/{username}/summary",
    "error_type": "status_code"
  },
  {
    "name": "Car Talk Community",
    "uri": "https://community.cartalk.com/u/{username}/summary",
    "error_type": "status_code"
  },
  {
    "name": "Carbonmade",
    "uri": "https://{username}.carbonmade.com",
    "error_type": "response_url",
    "regex": "^[\\w@-]+?$"
  },
  {
    "name": "Carrd",
    "uri": "https://{username}.carrd.co/",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9_-]{3,50}$"
  },
  {
    "name": "Career.habr",
    "uri": "https://career.habr.com/{username}",
    "error_type": "message",
    "error_msg": "<h1>Ошибка 404</h1>"
  },
  {
    "name": "CashApp",
    "uri": "https://cash.app/${username}",
    "error_type": "status_code"
  },
  {
    "name": "Championat",
    "uri": "https://www.championat.com/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Chaos",
    "uri": "https://chaos.social/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "Chatujme.cz",
    "uri": "https://profil.chatujme.cz/{username}",
    "error_type": "message",
    "error_msg": "Neexistujicí profil",
    "regex": "^[a-zA-Z][a-zA-Z1-9_-]*$"
  },
  {
    "name": "ChaturBate",
    "uri": "https://chaturbate.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Chess",
    "uri": "https://www.chess.com/member/{username}",
    "error_type": "message",
    "error_msg": "Username is valid",
    "regex": "^[a-zA-Z0-9_]{3,25}$"
  },
  {
    "name": "Choice Community",
    "uri": "https://choice.community/u/{username}/summary",
    "error_type": "status_code"
  },
  {
    "name": "Clapper",
    "uri": "https://clapperapp.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "CloudflareCommunity",
    "uri": "https://community.cloudflare.com/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Clozemaster",
    "uri": "https://www.clozemaster.com/players/{username}",
    "error_type": "message",
    "error_msg": "Oh no! Player not found."
  },
  {
    "name": "Clubhouse",
    "uri": "https://www.clubhouse.com/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "Code Snippet Wiki",
    "uri": "https://codesnippets.fandom.com/wiki/User:{username}",
    "error_type": "message",
    "error_msg": "This user has not filled out their profile page yet"
  },
  {
    "name": "Codeberg",
    "uri": "https://codeberg.org/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Codecademy",
    "uri": "https://www.codecademy.com/profiles/{username}",
    "error_type": "message",
    "error_msg": "This profile could not be found"
  },
  {
    "name": "Codechef",
    "uri": "https://www.codechef.com/users/{username}",
    "error_type": "response_url"
  },
  {
    "name": "Codeforces",
    "uri": "https://codeforces.com/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Codepen",
    "uri": "https://codepen.io/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Coders Rank",
    "uri": "https://profile.codersrank.io/user/{username}/",
    "error_type": "message",
    "error_msg": "not a registered member",
    "regex": "^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$"
  },
  {
    "name": "Coderwall",
    "uri": "https://coderwall.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "CodeSandbox",
    "uri": "https://codesandbox.io/u/{username}",
    "error_type": "message",
    "error_msg": "Could not find user with username",
    "regex": "^[a-zA-Z0-9_-]{3,30}$"
  },
  {
    "name": "Codewars",
    "uri": "https://www.codewars.com/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Codolio",
    "uri": "https://codolio.com/profile/{username}",
    "error_type": "message",
    "error_msg": "<title>Page Not Found | Codolio</title>",
    "regex": "^[a-zA-Z0-9_-]{3,30}$"
  },
  {
    "name": "Coinvote",
    "uri": "https://coinvote.cc/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "ColourLovers",
    "uri": "https://www.colourlovers.com/lover/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Contently",
    "uri": "https://{username}.contently.com/",
    "error_type": "response_url",
    "regex": "^[a-zA-Z][a-zA-Z0-9_-]*$"
  },
  {
    "name": "Coroflot",
    "uri": "https://www.coroflot.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Cplusplus",
    "uri": "https://cplusplus.com/user/{username}",
    "error_type": "message",
    "error_msg": "<title>404 Page Not Found</title>"
  },
  {
    "name": "Cracked",
    "uri": "https://www.cracked.com/members/{username}/",
    "error_type": "response_url"
  },
  {
    "name": "Cracked Forum",
    "uri": "https://cracked.ax/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Credly",
    "uri": "https://www.credly.com/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Crevado",
    "uri": "https://{username}.crevado.com",
    "error_type": "status_code",
    "regex": "^[\\w@-]+?$"
  },
  {
    "name": "Crowdin",
    "uri": "https://crowdin.com/profile/{username}",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9._-]{2,255}$"
  },
  {
    "name": "CryptoHack",
    "uri": "https://cryptohack.org/user/{username}/",
    "error_type": "response_url"
  },
  {
    "name": "Cryptomator Forum",
    "uri": "https://community.cryptomator.org/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Cults3D",
    "uri": "https://cults3d.com/en/users/{username}/creations",
    "error_type": "message",
    "error_msg": "Oh dear, this page is not working!"
  },
  {
    "name": "CyberDefenders",
    "uri": "https://cyberdefenders.org/p/{username}",
    "error_type": "status_code",
    "regex": "^[^\\/:*?\"<>|@]{3,50}$"
  },
  {
    "name": "DEV Community",
    "uri": "https://dev.to/{username}",
    "error_type": "status_code",
    "regex": "^[a-zA-Z][a-zA-Z0-9_-]*$"
  },
  {
    "name": "DMOJ",
    "uri": "https://dmoj.ca/user/{username}",
    "error_type": "message",
    "error_msg": "No such user"
  },
  {
    "name": "DailyMotion",
    "uri": "https://www.dailymotion.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "dcinside",
    "uri": "https://gallog.dcinside.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Dealabs",
    "uri": "https://www.dealabs.com/profile/{username}",
    "error_type": "message",
    "error_msg": "La page que vous essayez",
    "regex": "[a-z0-9]{4,16}"
  },
  {
    "name": "DeviantArt",
    "uri": "https://www.deviantart.com/{username}",
    "error_type": "message",
    "error_msg": "Llama Not Found",
    "regex": "^[a-zA-Z][a-zA-Z0-9_-]*$"
  },
  {
    "name": "DigitalSpy",
    "uri": "https://forums.digitalspy.com/profile/{username}",
    "error_type": "message",
    "error_msg": "The page you were looking for could not be found.",
    "regex": "^\\w{3,20}$"
  },
  {
    "name": "Discogs",
    "uri": "https://www.discogs.com/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Discord",
    "uri": "https://discord.com",
    "error_type": "message",
    "error_msg": "{\"taken\":false}"
  },
  {
    "name": "Discord.bio",
    "uri": "https://discords.com/api-v2/bio/details/{username}",
    "error_type": "message",
    "error_msg": "<title>Server Error (500)</title>"
  },
  {
    "name": "Discuss.Elastic.co",
    "uri": "https://discuss.elastic.co/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Diskusjon.no",
    "uri": "https://www.diskusjon.no",
    "error_type": "message",
    "error_msg": "{\"result\":\"ok\"}",
    "regex": "^[a-zA-Z0-9_.-]{3,40}$"
  },
  {
    "name": "Disqus",
    "uri": "https://disqus.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Docker Hub",
    "uri": "https://hub.docker.com/u/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "Dribbble",
    "uri": "https://dribbble.com/{username}",
    "error_type": "message",
    "error_msg": "Whoops, that page is gone.",
    "regex": "^[a-zA-Z][a-zA-Z0-9_-]*$"
  },
  {
    "name": "Duolingo",
    "uri": "https://www.duolingo.com/profile/{username}",
    "error_type": "message",
    "error_msg": "{\"users\":[]}"
  },
  {
    "name": "Eintracht Frankfurt Forum",
    "uri": "https://community.eintracht.de/fans/{username}",
    "error_type": "status_code",
    "regex": "^[^.]*?$"
  },
  {
    "name": "Empretienda AR",
    "uri": "https://{username}.empretienda.com.ar",
    "error_type": "status_code"
  },
  {
    "name": "Envato Forum",
    "uri": "https://forums.envato.com/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Erome",
    "uri": "https://www.erome.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Exposure",
    "uri": "https://{username}.exposure.co/",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9-]{1,63}$"
  },
  {
    "name": "exophase",
    "uri": "https://www.exophase.com/user/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "EyeEm",
    "uri": "https://www.eyeem.com/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "F3.cool",
    "uri": "https://f3.cool/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "Fameswap",
    "uri": "https://fameswap.com/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Fandom",
    "uri": "https://www.fandom.com/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Fanpop",
    "uri": "https://www.fanpop.com/fans/{username}",
    "error_type": "response_url"
  },
  {
    "name": "Finanzfrage",
    "uri": "https://www.finanzfrage.net/nutzer/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Flickr",
    "uri": "https://www.flickr.com/people/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Flightradar24",
    "uri": "https://my.flightradar24.com/{username}",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9_]{3,20}$"
  },
  {
    "name": "Flipboard",
    "uri": "https://flipboard.com/@{username}",
    "error_type": "status_code",
    "regex": "^([a-zA-Z0-9_]){1,15}$"
  },
  {
    "name": "Football",
    "uri": "https://www.rusfootball.info/user/{username}/",
    "error_type": "message",
    "error_msg": "Пользователь с таким именем не найден"
  },
  {
    "name": "FortniteTracker",
    "uri": "https://fortnitetracker.com/profile/all/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Forum Ophilia",
    "uri": "https://www.forumophilia.com/profile.php?mode=viewprofile&u={username}",
    "error_type": "message",
    "error_msg": "that user does not exist"
  },
  {
    "name": "Fosstodon",
    "uri": "https://fosstodon.org/@{username}",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9_]{1,30}$"
  },
  {
    "name": "Framapiaf",
    "uri": "https://framapiaf.org/@{username}",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9_]{1,30}$"
  },
  {
    "name": "Freelancer",
    "uri": "https://www.freelancer.com/u/{username}",
    "error_type": "message",
    "error_msg": "\"users\":{}"
  },
  {
    "name": "Freesound",
    "uri": "https://freesound.org/people/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "GNOME VCS",
    "uri": "https://gitlab.gnome.org/{username}",
    "error_type": "response_url",
    "regex": "^(?!-)[a-zA-Z0-9_.-]{2,255}(?<!\\.)$"
  },
  {
    "name": "GaiaOnline",
    "uri": "https://www.gaiaonline.com/profiles/{username}",
    "error_type": "message",
    "error_msg": "No user ID specified or user does not exist"
  },
  {
    "name": "Gamespot",
    "uri": "https://www.gamespot.com/profile/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "GameFAQs",
    "uri": "https://gamefaqs.gamespot.com/community/{username}",
    "error_type": "status_code"
  },
  {
    "name": "GeeksforGeeks",
    "uri": "https://auth.geeksforgeeks.org/user/{username}",
    "error_type": "message",
    "error_msg": "false   | GeeksforGeeks Profile"
  },
  {
    "name": "Genius (Artists)",
    "uri": "https://genius.com/artists/{username}",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9]{5,50}$"
  },
  {
    "name": "Genius (Users)",
    "uri": "https://genius.com/{username}",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9]*?$"
  },
  {
    "name": "Gesundheitsfrage",
    "uri": "https://www.gesundheitsfrage.net/nutzer/{username}",
    "error_type": "status_code"
  },
  {
    "name": "GetMyUni",
    "uri": "https://www.getmyuni.com/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Giant Bomb",
    "uri": "https://www.giantbomb.com/profile/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "Giphy",
    "uri": "https://giphy.com/{username}",
    "error_type": "message",
    "error_msg": "<title> GIFs - Find &amp; Share on GIPHY</title>"
  },
  {
    "name": "GitBook",
    "uri": "https://{username}.gitbook.io/",
    "error_type": "status_code",
    "regex": "^[\\w@-]+?$"
  },
  {
    "name": "GitHub",
    "uri": "https://www.github.com/{username}",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$"
  },
  {
    "name": "Warframe Market",
    "uri": "https://warframe.market/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "GitLab",
    "uri": "https://gitlab.com/{username}",
    "error_type": "message",
    "error_msg": "[]"
  },
  {
    "name": "Gitea",
    "uri": "https://gitea.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Gitee",
    "uri": "https://gitee.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "GoodReads",
    "uri": "https://www.goodreads.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Google Play",
    "uri": "https://play.google.com/store/apps/developer?id={username}",
    "error_type": "message",
    "error_msg": "the requested URL was not found on this server"
  },
  {
    "name": "Gradle",
    "uri": "https://plugins.gradle.org/u/{username}",
    "error_type": "status_code",
    "regex": "^(?!-)[a-zA-Z0-9-]{3,}(?<!-)$"
  },
  {
    "name": "Grailed",
    "uri": "https://www.grailed.com/{username}",
    "error_type": "response_url"
  },
  {
    "name": "Gravatar",
    "uri": "http://en.gravatar.com/{username}",
    "error_type": "status_code",
    "regex": "^((?!\\.).)*$"
  },
  {
    "name": "Gumroad",
    "uri": "https://www.gumroad.com/{username}",
    "error_type": "message",
    "error_msg": "Page not found (404) - Gumroad",
    "regex": "^[^.]*?$"
  },
  {
    "name": "Gutefrage",
    "uri": "https://www.gutefrage.net/nutzer/{username}",
    "error_type": "status_code"
  },
  {
    "name": "HackTheBox",
    "uri": "https://forum.hackthebox.com/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Hackaday",
    "uri": "https://hackaday.io/{username}",
    "error_type": "status_code"
  },
  {
    "name": "HackenProof (Hackers)",
    "uri": "https://hackenproof.com/hackers/{username}",
    "error_type": "message",
    "error_msg": "Page not found",
    "regex": "^[\\w-]{,34}$"
  },
  {
    "name": "HackerEarth",
    "uri": "https://hackerearth.com/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "HackerNews",
    "uri": "https://news.ycombinator.com/user?id={username}",
    "error_type": "message",
    "error_msg": "No such user."
  },
  {
    "name": "HackerOne",
    "uri": "https://hackerone.com/{username}",
    "error_type": "message",
    "error_msg": "Page not found"
  },
  {
    "name": "HackerRank",
    "uri": "https://hackerrank.com/{username}",
    "error_type": "message",
    "error_msg": "Something went wrong",
    "regex": "^[^.]*?$"
  },
  {
    "name": "HackerSploit",
    "uri": "https://forum.hackersploit.org/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "HackMD",
    "uri": "https://hackmd.io/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "Harvard Scholar",
    "uri": "https://scholar.harvard.edu/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Hashnode",
    "uri": "https://hashnode.com/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "Heavy-R",
    "uri": "https://www.heavy-r.com/user/{username}",
    "error_type": "message",
    "error_msg": "Channel not found"
  },
  {
    "name": "Hive Blog",
    "uri": "https://hive.blog/@{username}",
    "error_type": "message",
    "error_msg": "<title>User Not Found - Hive</title>"
  },
  {
    "name": "Holopin",
    "uri": "https://holopin.io/@{username}",
    "error_type": "message",
    "error_msg": "true"
  },
  {
    "name": "Houzz",
    "uri": "https://houzz.com/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "HubPages",
    "uri": "https://hubpages.com/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "Hubski",
    "uri": "https://hubski.com/user/{username}",
    "error_type": "message",
    "error_msg": "No such user"
  },
  {
    "name": "HudsonRock",
    "uri": "https://cavalier.hudsonrock.com/api/json/v2/osint-tools/search-by-username?username={username}",
    "error_type": "message",
    "error_msg": "This username is not associated"
  },
  {
    "name": "Hugging Face",
    "uri": "https://huggingface.co/{username}",
    "error_type": "status_code"
  },
  {
    "name": "IFTTT",
    "uri": "https://www.ifttt.com/p/{username}",
    "error_type": "status_code",
    "regex": "^[A-Za-z0-9]{3,35}$"
  },
  {
    "name": "Ifunny",
    "uri": "https://ifunny.co/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "IRC-Galleria",
    "uri": "https://irc-galleria.net/user/{username}",
    "error_type": "response_url"
  },
  {
    "name": "Icons8 Community",
    "uri": "https://community.icons8.com/u/{username}/summary",
    "error_type": "status_code"
  },
  {
    "name": "Image Fap",
    "uri": "https://www.imagefap.com/profile/{username}",
    "error_type": "message",
    "error_msg": "Not found"
  },
  {
    "name": "ImgUp.cz",
    "uri": "https://imgup.cz/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Imgur",
    "uri": "https://imgur.com/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "imood",
    "uri": "https://www.imood.com/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Instagram",
    "uri": "https://instagram.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Instapaper",
    "uri": "https://www.instapaper.com/p/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Instructables",
    "uri": "https://www.instructables.com/member/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Intigriti",
    "uri": "https://app.intigriti.com/profile/{username}",
    "error_type": "status_code",
    "regex": "[a-z0-9_]{1,25}"
  },
  {
    "name": "Ionic Forum",
    "uri": "https://forum.ionicframework.com/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Issuu",
    "uri": "https://issuu.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Itch.io",
    "uri": "https://{username}.itch.io/",
    "error_type": "status_code",
    "regex": "^[\\w@-]+?$"
  },
  {
    "name": "Itemfix",
    "uri": "https://www.itemfix.com/c/{username}",
    "error_type": "message",
    "error_msg": "<title>ItemFix - Channel: </title>"
  },
  {
    "name": "Jellyfin Weblate",
    "uri": "https://translate.jellyfin.org/user/{username}/",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9@._-]{1,150}$"
  },
  {
    "name": "Jimdo",
    "uri": "https://{username}.jimdosite.com",
    "error_type": "status_code",
    "regex": "^[\\w@-]+?$"
  },
  {
    "name": "Joplin Forum",
    "uri": "https://discourse.joplinapp.org/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Jupyter Community Forum",
    "uri": "https://discourse.jupyter.org/u/{username}/summary",
    "error_type": "message",
    "error_msg": "Oops! That page doesn’t exist or is private."
  },
  {
    "name": "Kaggle",
    "uri": "https://www.kaggle.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "kaskus",
    "uri": "https://www.kaskus.co.id/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "Keybase",
    "uri": "https://keybase.io/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Kick",
    "uri": "https://kick.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Kik",
    "uri": "https://kik.me/{username}",
    "error_type": "message",
    "error_msg": "The page you requested was not found"
  },
  {
    "name": "Kongregate",
    "uri": "https://www.kongregate.com/accounts/{username}",
    "error_type": "status_code",
    "regex": "^[a-zA-Z][a-zA-Z0-9_-]*$"
  },
  {
    "name": "Kvinneguiden",
    "uri": "https://forum.kvinneguiden.no",
    "error_type": "message",
    "error_msg": "{\"result\":\"ok\"}",
    "regex": "^[a-zA-Z0-9_.-]{3,18}$"
  },
  {
    "name": "LOR",
    "uri": "https://www.linux.org.ru/people/{username}/profile",
    "error_type": "status_code"
  },
  {
    "name": "Laracast",
    "uri": "https://laracasts.com/@{username}",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9_-]{3,}$"
  },
  {
    "name": "Launchpad",
    "uri": "https://launchpad.net/~{username}",
    "error_type": "status_code"
  },
  {
    "name": "LeetCode",
    "uri": "https://leetcode.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "LemmyWorld",
    "uri": "https://lemmy.world/u/{username}",
    "error_type": "message",
    "error_msg": "<h1>Error!</h1>"
  },
  {
    "name": "LessWrong",
    "uri": "https://www.lesswrong.com/users/{username}",
    "error_type": "response_url"
  },
  {
    "name": "Letterboxd",
    "uri": "https://letterboxd.com/{username}",
    "error_type": "message",
    "error_msg": "Sorry, we can’t find the page you’ve requested."
  },
  {
    "name": "LibraryThing",
    "uri": "https://www.librarything.com/profile/{username}",
    "error_type": "message",
    "error_msg": "<p>Error: This user doesn't exist</p>"
  },
  {
    "name": "Lichess",
    "uri": "https://lichess.org/@/{username}",
    "error_type": "status_code"
  },
  {
    "name": "LinkedIn",
    "uri": "https://linkedin.com/in/{username}",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9]{3,100}$"
  },
  {
    "name": "Linktree",
    "uri": "https://linktr.ee/{username}",
    "error_type": "message",
    "error_msg": "\"statusCode\":404",
    "regex": "^[\\w\\.]{2,30}$"
  },
  {
    "name": "LinuxFR.org",
    "uri": "https://linuxfr.org/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Listed",
    "uri": "https://listed.to/@{username}",
    "error_type": "response_url"
  },
  {
    "name": "LiveJournal",
    "uri": "https://{username}.livejournal.com",
    "error_type": "status_code",
    "regex": "^[a-zA-Z][a-zA-Z0-9_-]*$"
  },
  {
    "name": "Lobsters",
    "uri": "https://lobste.rs/u/{username}",
    "error_type": "status_code",
    "regex": "[A-Za-z0-9][A-Za-z0-9_-]{0,24}"
  },
  {
    "name": "LottieFiles",
    "uri": "https://lottiefiles.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "LushStories",
    "uri": "https://www.lushstories.com/profile/{username}",
    "error_type": "response_url"
  },
  {
    "name": "MMORPG Forum",
    "uri": "https://forums.mmorpg.com/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Mamot",
    "uri": "https://mamot.fr/@{username}",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9_]{1,30}$"
  },
  {
    "name": "Medium",
    "uri": "https://medium.com/@{username}",
    "error_type": "message",
    "error_msg": "<body"
  },
  {
    "name": "Memrise",
    "uri": "https://www.memrise.com/user/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "Minecraft",
    "uri": "https://api.mojang.com/users/profiles/minecraft/{username}",
    "error_type": "message",
    "error_msg": "Couldn't find any profile with name",
    "regex": "^.{1,25}$"
  },
  {
    "name": "MixCloud",
    "uri": "https://www.mixcloud.com/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "Monkeytype",
    "uri": "https://monkeytype.com/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Motherless",
    "uri": "https://motherless.com/m/{username}",
    "error_type": "message",
    "error_msg": "no longer a member"
  },
  {
    "name": "Motorradfrage",
    "uri": "https://www.motorradfrage.net/nutzer/{username}",
    "error_type": "status_code"
  },
  {
    "name": "MuseScore",
    "uri": "https://musescore.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "MyAnimeList",
    "uri": "https://myanimelist.net/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "MyMiniFactory",
    "uri": "https://www.myminifactory.com/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Mydramalist",
    "uri": "https://www.mydramalist.com/profile/{username}",
    "error_type": "message",
    "error_msg": "The requested page was not found"
  },
  {
    "name": "Myspace",
    "uri": "https://myspace.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "NICommunityForum",
    "uri": "https://community.native-instruments.com/profile/{username}",
    "error_type": "message",
    "error_msg": "The page you were looking for could not be found."
  },
  {
    "name": "namuwiki",
    "uri": "https://namu.wiki/w/%EC%82%AC%EC%9A%A9%EC%9E%90:{username}",
    "error_type": "status_code"
  },
  {
    "name": "NationStates Nation",
    "uri": "https://nationstates.net/nation={username}",
    "error_type": "message",
    "error_msg": "Was this your nation? It may have ceased to exist due to inactivity, but can rise again!"
  },
  {
    "name": "NationStates Region",
    "uri": "https://nationstates.net/region={username}",
    "error_type": "message",
    "error_msg": "does not exist."
  },
  {
    "name": "Naver",
    "uri": "https://blog.naver.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Needrom",
    "uri": "https://www.needrom.com/author/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "Newgrounds",
    "uri": "https://{username}.newgrounds.com",
    "error_type": "status_code",
    "regex": "^[a-zA-Z][a-zA-Z0-9_-]*$"
  },
  {
    "name": "Nextcloud Forum",
    "uri": "https://help.nextcloud.com/u/{username}/summary",
    "error_type": "status_code",
    "regex": "^(?![.-])[a-zA-Z0-9_.-]{3,20}$"
  },
  {
    "name": "Nightbot",
    "uri": "https://nightbot.tv/t/{username}/commands",
    "error_type": "status_code"
  },
  {
    "name": "Ninja Kiwi",
    "uri": "https://ninjakiwi.com/profile/{username}",
    "error_type": "response_url"
  },
  {
    "name": "NintendoLife",
    "uri": "https://www.nintendolife.com/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "NitroType",
    "uri": "https://www.nitrotype.com/racer/{username}",
    "error_type": "message",
    "error_msg": "<title>Nitro Type | Competitive Typing Game | Race Your Friends</title>"
  },
  {
    "name": "NotABug.org",
    "uri": "https://notabug.org/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Nothing Community",
    "uri": "https://nothing.community/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Nyaa.si",
    "uri": "https://nyaa.si/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "ObservableHQ",
    "uri": "https://observablehq.com/@{username}",
    "error_type": "message",
    "error_msg": "Page not found"
  },
  {
    "name": "Open Collective",
    "uri": "https://opencollective.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "OpenGameArt",
    "uri": "https://opengameart.org/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "OpenStreetMap",
    "uri": "https://www.openstreetmap.org/user/{username}",
    "error_type": "status_code",
    "regex": "^[^.]*?$"
  },
  {
    "name": "Odysee",
    "uri": "https://odysee.com/@{username}",
    "error_type": "message",
    "error_msg": "<link rel=\"canonical\" content=\"odysee.com\"/>"
  },
  {
    "name": "Opensource",
    "uri": "https://opensource.com/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "OurDJTalk",
    "uri": "https://ourdjtalk.com/members?username={username}",
    "error_type": "message",
    "error_msg": "The specified member cannot be found"
  },
  {
    "name": "Outgress",
    "uri": "https://outgress.com/agents/{username}",
    "error_type": "message",
    "error_msg": "Outgress - Error"
  },
  {
    "name": "PCGamer",
    "uri": "https://forums.pcgamer.com/members/?username={username}",
    "error_type": "message",
    "error_msg": "The specified member cannot be found. Please enter a member's entire name."
  },
  {
    "name": "PSNProfiles.com",
    "uri": "https://psnprofiles.com/{username}",
    "error_type": "response_url"
  },
  {
    "name": "Packagist",
    "uri": "https://packagist.org/packages/{username}/",
    "error_type": "response_url"
  },
  {
    "name": "Pastebin",
    "uri": "https://pastebin.com/u/{username}",
    "error_type": "message",
    "error_msg": "Not Found (#404)"
  },
  {
    "name": "Patched",
    "uri": "https://patched.sh/User/{username}",
    "error_type": "message",
    "error_msg": "The member you specified is either invalid or doesn't exist."
  },
  {
    "name": "Patreon",
    "uri": "https://www.patreon.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "PentesterLab",
    "uri": "https://pentesterlab.com/profile/{username}",
    "error_type": "status_code",
    "regex": "^[\\w]{4,30}$"
  },
  {
    "name": "HotUKdeals",
    "uri": "https://www.hotukdeals.com/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Mydealz",
    "uri": "https://www.mydealz.de/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Chollometro",
    "uri": "https://www.chollometro.com/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "PepperNL",
    "uri": "https://nl.pepper.com/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "PepperPL",
    "uri": "https://www.pepper.pl/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Preisjaeger",
    "uri": "https://www.preisjaeger.at/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Pepperdeals",
    "uri": "https://www.pepperdeals.se/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "PepperealsUS",
    "uri": "https://www.pepperdeals.com/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Promodescuentos",
    "uri": "https://www.promodescuentos.com/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Periscope",
    "uri": "https://www.periscope.tv/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "Pinkbike",
    "uri": "https://www.pinkbike.com/u/{username}/",
    "error_type": "status_code",
    "regex": "^[^.]*?$"
  },
  {
    "name": "pixelfed.social",
    "uri": "https://pixelfed.social/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "PlayStore",
    "uri": "https://play.google.com/store/apps/developer?id={username}",
    "error_type": "status_code"
  },
  {
    "name": "Playstrategy",
    "uri": "https://playstrategy.org/@/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Plurk",
    "uri": "https://www.plurk.com/{username}",
    "error_type": "message",
    "error_msg": "User Not Found!"
  },
  {
    "name": "PocketStars",
    "uri": "https://pocketstars.com/{username}",
    "error_type": "message",
    "error_msg": "Join Your Favorite Adult Stars"
  },
  {
    "name": "Pokemon Showdown",
    "uri": "https://pokemonshowdown.com/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Polarsteps",
    "uri": "https://polarsteps.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Polygon",
    "uri": "https://www.polygon.com/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Polymart",
    "uri": "https://polymart.org/user/{username}",
    "error_type": "response_url"
  },
  {
    "name": "Pornhub",
    "uri": "https://pornhub.com/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "ProductHunt",
    "uri": "https://www.producthunt.com/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "programming.dev",
    "uri": "https://programming.dev/u/{username}",
    "error_type": "message",
    "error_msg": "Error!"
  },
  {
    "name": "Pychess",
    "uri": "https://www.pychess.org/@/{username}",
    "error_type": "message",
    "error_msg": "404"
  },
  {
    "name": "PromoDJ",
    "uri": "http://promodj.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Pronouns.page",
    "uri": "https://pronouns.page/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "PyPi",
    "uri": "https://pypi.org/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Python.org Discussions",
    "uri": "https://discuss.python.org/u/{username}/summary",
    "error_type": "message",
    "error_msg": "Oops! That page doesn’t exist or is private."
  },
  {
    "name": "Rajce.net",
    "uri": "https://{username}.rajce.idnes.cz/",
    "error_type": "status_code",
    "regex": "^[\\w@-]+?$"
  },
  {
    "name": "Rarible",
    "uri": "https://rarible.com/marketplace/api/v4/urls/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Rate Your Music",
    "uri": "https://rateyourmusic.com/~{username}",
    "error_type": "status_code"
  },
  {
    "name": "Rclone Forum",
    "uri": "https://forum.rclone.org/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "RedTube",
    "uri": "https://www.redtube.com/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Redbubble",
    "uri": "https://www.redbubble.com/people/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Reddit",
    "uri": "https://www.reddit.com/user/{username}",
    "error_type": "message",
    "error_msg": "Sorry, nobody on Reddit goes by that name."
  },
  {
    "name": "Realmeye",
    "uri": "https://www.realmeye.com/player/{username}",
    "error_type": "message",
    "error_msg": "Sorry, but we either:"
  },
  {
    "name": "Reisefrage",
    "uri": "https://www.reisefrage.net/nutzer/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Replit.com",
    "uri": "https://replit.com/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "ResearchGate",
    "uri": "https://www.researchgate.net/profile/{username}",
    "error_type": "response_url",
    "regex": "\\w+_\\w+"
  },
  {
    "name": "ReverbNation",
    "uri": "https://www.reverbnation.com/{username}",
    "error_type": "message",
    "error_msg": "Sorry, we couldn't find that page"
  },
  {
    "name": "Roblox",
    "uri": "https://www.roblox.com/user.aspx?username={username}",
    "error_type": "status_code"
  },
  {
    "name": "RocketTube",
    "uri": "https://www.rockettube.com/{username}",
    "error_type": "message",
    "error_msg": "OOPS! Houston, we have a problem"
  },
  {
    "name": "RoyalCams",
    "uri": "https://royalcams.com/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Ruby Forums",
    "uri": "https://ruby-forum.com/u/{username}/summary",
    "error_type": "message",
    "error_msg": "Oops! That page doesn’t exist or is private."
  },
  {
    "name": "RubyGems",
    "uri": "https://rubygems.org/profiles/{username}",
    "error_type": "status_code",
    "regex": "^[a-zA-Z][a-zA-Z0-9_-]{1,40}"
  },
  {
    "name": "Rumble",
    "uri": "https://rumble.com/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "RuneScape",
    "uri": "https://apps.runescape.com/runemetrics/app/overview/player/{username}",
    "error_type": "message",
    "error_msg": "{\"error\":\"NO_PROFILE\",\"loggedIn\":\"false\"}",
    "regex": "^(?! )[\\w -]{1,12}(?<! )$"
  },
  {
    "name": "SWAPD",
    "uri": "https://swapd.co/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Sbazar.cz",
    "uri": "https://www.sbazar.cz/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Scratch",
    "uri": "https://scratch.mit.edu/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Scribd",
    "uri": "https://www.scribd.com/{username}",
    "error_type": "message",
    "error_msg": "Page not found"
  },
  {
    "name": "SEOForum",
    "uri": "https://seoforum.com/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "Shelf",
    "uri": "https://www.shelf.im/{username}",
    "error_type": "status_code"
  },
  {
    "name": "ShitpostBot5000",
    "uri": "https://www.shitpostbot.com/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Signal",
    "uri": "https://community.signalusers.org/u/{username}",
    "error_type": "message",
    "error_msg": "Oops! That page doesn’t exist or is private."
  },
  {
    "name": "Sketchfab",
    "uri": "https://sketchfab.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Slack",
    "uri": "https://{username}.slack.com",
    "error_type": "status_code",
    "regex": "^[a-zA-Z][a-zA-Z0-9_-]*$"
  },
  {
    "name": "Slant",
    "uri": "https://www.slant.co/users/{username}",
    "error_type": "status_code",
    "regex": "^.{2,32}$"
  },
  {
    "name": "Slashdot",
    "uri": "https://slashdot.org/~{username}",
    "error_type": "message",
    "error_msg": "user you requested does not exist"
  },
  {
    "name": "SlideShare",
    "uri": "https://slideshare.net/{username}",
    "error_type": "message",
    "error_msg": "<title>Page no longer exists</title>"
  },
  {
    "name": "Slides",
    "uri": "https://slides.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "SmugMug",
    "uri": "https://{username}.smugmug.com",
    "error_type": "status_code",
    "regex": "^[a-zA-Z]{1,35}$"
  },
  {
    "name": "Smule",
    "uri": "https://www.smule.com/{username}",
    "error_type": "message",
    "error_msg": "Smule | Page Not Found (404)"
  },
  {
    "name": "Snapchat",
    "uri": "https://www.snapchat.com/add/{username}",
    "error_type": "status_code",
    "regex": "^[a-z][a-z-_.]{3,15}"
  },
  {
    "name": "SOOP",
    "uri": "https://www.sooplive.co.kr/station/{username}",
    "error_type": "status_code"
  },
  {
    "name": "SoundCloud",
    "uri": "https://soundcloud.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "SourceForge",
    "uri": "https://sourceforge.net/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "SpaceHey",
    "uri": "https://spacehey.com/{username}",
    "error_type": "message",
    "error_msg": "Not Found (Error 404) | SpaceHey"
  },
  {
    "name": "SoylentNews",
    "uri": "https://soylentnews.org/~{username}",
    "error_type": "message",
    "error_msg": "The user you requested does not exist, no matter how much you wish this might be the case."
  },
  {
    "name": "SpeakerDeck",
    "uri": "https://speakerdeck.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Speedrun.com",
    "uri": "https://speedrun.com/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Spells8",
    "uri": "https://forum.spells8.com/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Splice",
    "uri": "https://splice.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Splits.io",
    "uri": "https://splits.io/users/{username}",
    "error_type": "status_code",
    "regex": "^[^.]*?$"
  },
  {
    "name": "Sporcle",
    "uri": "https://www.sporcle.com/user/{username}/people",
    "error_type": "status_code"
  },
  {
    "name": "Sportlerfrage",
    "uri": "https://www.sportlerfrage.net/nutzer/{username}",
    "error_type": "status_code"
  },
  {
    "name": "SportsRU",
    "uri": "https://www.sports.ru/profile/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "Spotify",
    "uri": "https://open.spotify.com/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Star Citizen",
    "uri": "https://robertsspaceindustries.com/citizens/{username}",
    "error_type": "message",
    "error_msg": "404"
  },
  {
    "name": "Status Cafe",
    "uri": "https://status.cafe/users/{username}",
    "error_type": "message",
    "error_msg": "Page Not Found"
  },
  {
    "name": "Steam Community (Group)",
    "uri": "https://steamcommunity.com/groups/{username}",
    "error_type": "message",
    "error_msg": "No group could be retrieved for the given URL"
  },
  {
    "name": "Steam Community (User)",
    "uri": "https://steamcommunity.com/id/{username}/",
    "error_type": "message",
    "error_msg": "The specified profile could not be found"
  },
  {
    "name": "Strava",
    "uri": "https://www.strava.com/athletes/{username}",
    "error_type": "status_code",
    "regex": "^[^.]*?$"
  },
  {
    "name": "Substack",
    "uri": "https://{username}.substack.com/",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9][a-zA-Z0-9_-]{1,60}$"
  },
  {
    "name": "SublimeForum",
    "uri": "https://forum.sublimetext.com/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "TETR.IO",
    "uri": "https://ch.tetr.io/u/{username}",
    "error_type": "message",
    "error_msg": "No such user!"
  },
  {
    "name": "TheMovieDB",
    "uri": "https://www.themoviedb.org/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "TikTok",
    "uri": "https://www.tiktok.com/@{username}",
    "error_type": "message",
    "error_msg": "\"statusCode\":10221"
  },
  {
    "name": "Tiendanube",
    "uri": "https://{username}.mitiendanube.com/",
    "error_type": "status_code"
  },
  {
    "name": "Topcoder",
    "uri": "https://profiles.topcoder.com/{username}/",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9_.]+$"
  },
  {
    "name": "Topmate",
    "uri": "https://topmate.io/{username}",
    "error_type": "status_code"
  },
  {
    "name": "TRAKTRAIN",
    "uri": "https://traktrain.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Telegram",
    "uri": "https://t.me/{username}",
    "error_type": "message",
    "error_msg": "<title>Telegram Messenger</title>",
    "regex": "^[a-zA-Z0-9_]{3,32}[^_]$"
  },
  {
    "name": "Tellonym.me",
    "uri": "https://tellonym.me/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Tenor",
    "uri": "https://tenor.com/users/{username}",
    "error_type": "status_code",
    "regex": "^[A-Za-z0-9_]{2,32}$"
  },
  {
    "name": "Terraria Forums",
    "uri": "https://forums.terraria.org/index.php?search/42798315/&c[users]={username}&o=relevance",
    "error_type": "message",
    "error_msg": "The following members could not be found"
  },
  {
    "name": "ThemeForest",
    "uri": "https://themeforest.net/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "tistory",
    "uri": "https://{username}.tistory.com/",
    "error_type": "status_code"
  },
  {
    "name": "TnAFlix",
    "uri": "https://www.tnaflix.com/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "TradingView",
    "uri": "https://www.tradingview.com/u/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "Trakt",
    "uri": "https://www.trakt.tv/users/{username}",
    "error_type": "status_code",
    "regex": "^[^.]*$"
  },
  {
    "name": "TrashboxRU",
    "uri": "https://trashbox.ru/users/{username}",
    "error_type": "status_code",
    "regex": "^[A-Za-z0-9_-]{3,16}$"
  },
  {
    "name": "Trawelling",
    "uri": "https://traewelling.de/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "Trello",
    "uri": "https://trello.com/{username}",
    "error_type": "message",
    "error_msg": "model not found"
  },
  {
    "name": "TryHackMe",
    "uri": "https://tryhackme.com/p/{username}",
    "error_type": "message",
    "error_msg": "{\"success\":false}",
    "regex": "^[a-zA-Z0-9.]{1,16}$"
  },
  {
    "name": "Tuna",
    "uri": "https://tuna.voicemod.net/user/{username}",
    "error_type": "status_code",
    "regex": "^[a-z0-9]{4,40}$"
  },
  {
    "name": "Tweakers",
    "uri": "https://tweakers.net/gallery/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Twitch",
    "uri": "https://www.twitch.tv/{username}",
    "error_type": "message",
    "error_msg": "content='Twitch is the world&#39;s leading video platform and community for gamers.'"
  },
  {
    "name": "Trovo",
    "uri": "https://trovo.live/s/{username}/",
    "error_type": "message",
    "error_msg": "Uh Ohhh..."
  },
  {
    "name": "Twitter",
    "uri": "https://x.com/{username}",
    "error_type": "message",
    "error_msg": "<div class=\"error-panel\"><span>User ",
    "regex": "^[a-zA-Z0-9_]{1,15}$"
  },
  {
    "name": "Typeracer",
    "uri": "https://data.typeracer.com/pit/profile?user={username}",
    "error_type": "message",
    "error_msg": "Profile Not Found"
  },
  {
    "name": "Ultimate-Guitar",
    "uri": "https://ultimate-guitar.com/u/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Unsplash",
    "uri": "https://unsplash.com/@{username}",
    "error_type": "status_code",
    "regex": "^[a-z0-9_]{1,60}$"
  },
  {
    "name": "Untappd",
    "uri": "https://untappd.com/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Valorant Forums",
    "uri": "https://valorantforums.com/u/{username}",
    "error_type": "message",
    "error_msg": "The page you requested could not be found."
  },
  {
    "name": "VK",
    "uri": "https://vk.com/{username}",
    "error_type": "response_url"
  },
  {
    "name": "VSCO",
    "uri": "https://vsco.co/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Velog",
    "uri": "https://velog.io/@{username}/posts",
    "error_type": "status_code"
  },
  {
    "name": "Velomania",
    "uri": "https://forum.velomania.ru/member.php?username={username}",
    "error_type": "message",
    "error_msg": "Пользователь не зарегистрирован и не имеет профиля для просмотра."
  },
  {
    "name": "Venmo",
    "uri": "https://account.venmo.com/u/{username}",
    "error_type": "message",
    "error_msg": "Venmo | Page Not Found"
  },
  {
    "name": "Vero",
    "uri": "https://vero.co/{username}",
    "error_type": "message",
    "error_msg": "Not Found"
  },
  {
    "name": "Vimeo",
    "uri": "https://vimeo.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "VirusTotal",
    "uri": "https://www.virustotal.com/gui/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "VLR",
    "uri": "https://www.vlr.gg/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "WICG Forum",
    "uri": "https://discourse.wicg.io/u/{username}/summary",
    "error_type": "status_code",
    "regex": "^(?![.-])[a-zA-Z0-9_.-]{3,20}$"
  },
  {
    "name": "Wakatime",
    "uri": "https://wakatime.com/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "Warrior Forum",
    "uri": "https://www.warriorforum.com/members/{username}.html",
    "error_type": "status_code"
  },
  {
    "name": "Wattpad",
    "uri": "https://www.wattpad.com/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "WebNode",
    "uri": "https://{username}.webnode.cz/",
    "error_type": "status_code",
    "regex": "^[\\w@-]+?$"
  },
  {
    "name": "Weblate",
    "uri": "https://hosted.weblate.org/user/{username}/",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9@._-]{1,150}$"
  },
  {
    "name": "Weebly",
    "uri": "https://{username}.weebly.com/",
    "error_type": "status_code",
    "regex": "^[a-zA-Z0-9-]{1,63}$"
  },
  {
    "name": "Wikidot",
    "uri": "http://www.wikidot.com/user:info/{username}",
    "error_type": "message",
    "error_msg": "User does not exist."
  },
  {
    "name": "Wikipedia",
    "uri": "https://en.wikipedia.org/wiki/Special:CentralAuth/{username}?uselang=qqx",
    "error_type": "message",
    "error_msg": "centralauth-admin-nonexistent:"
  },
  {
    "name": "Windy",
    "uri": "https://community.windy.com/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Wix",
    "uri": "https://{username}.wix.com",
    "error_type": "status_code",
    "regex": "^[\\w@-]+?$"
  },
  {
    "name": "WolframalphaForum",
    "uri": "https://community.wolfram.com/web/{username}/home",
    "error_type": "status_code"
  },
  {
    "name": "WordPress",
    "uri": "https://{username}.wordpress.com/",
    "error_type": "response_url",
    "regex": "^[a-zA-Z][a-zA-Z0-9_-]*$"
  },
  {
    "name": "WordPressOrg",
    "uri": "https://profiles.wordpress.org/{username}/",
    "error_type": "response_url"
  },
  {
    "name": "Wordnik",
    "uri": "https://www.wordnik.com/users/{username}",
    "error_type": "message",
    "error_msg": "Page Not Found",
    "regex": "^[a-zA-Z0-9_.+-]{1,40}$"
  },
  {
    "name": "Wykop",
    "uri": "https://www.wykop.pl/ludzie/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Xbox Gamertag",
    "uri": "https://xboxgamertag.com/search/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Xvideos",
    "uri": "https://xvideos.com/profiles/{username}",
    "error_type": "status_code"
  },
  {
    "name": "YandexMusic",
    "uri": "https://music.yandex/users/{username}/playlists",
    "error_type": "message",
    "error_msg": "Ошибка 404"
  },
  {
    "name": "YouNow",
    "uri": "https://www.younow.com/{username}/",
    "error_type": "message",
    "error_msg": "No users found"
  },
  {
    "name": "YouPic",
    "uri": "https://youpic.com/photographer/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "YouPorn",
    "uri": "https://youporn.com/uservids/{username}",
    "error_type": "status_code"
  },
  {
    "name": "YouTube",
    "uri": "https://www.youtube.com/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "akniga",
    "uri": "https://akniga.org/profile/{username}",
    "error_type": "status_code"
  },
  {
    "name": "authorSTREAM",
    "uri": "http://www.authorstream.com/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "babyblogRU",
    "uri": "https://www.babyblog.ru/user/{username}",
    "error_type": "response_url"
  },
  {
    "name": "chaos.social",
    "uri": "https://chaos.social/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "couchsurfing",
    "uri": "https://www.couchsurfing.com/people/{username}",
    "error_type": "status_code"
  },
  {
    "name": "d3RU",
    "uri": "https://d3.ru/user/{username}/posts",
    "error_type": "status_code"
  },
  {
    "name": "dailykos",
    "uri": "https://www.dailykos.com/user/{username}",
    "error_type": "message",
    "error_msg": "{\"result\":true,\"message\":null}"
  },
  {
    "name": "datingRU",
    "uri": "http://dating.ru/{username}",
    "error_type": "status_code"
  },
  {
    "name": "devRant",
    "uri": "https://devrant.com/users/{username}",
    "error_type": "response_url"
  },
  {
    "name": "drive2",
    "uri": "https://www.drive2.ru/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "eGPU",
    "uri": "https://egpu.io/forums/profile/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "eintracht",
    "uri": "https://community.eintracht.de/fans/{username}",
    "error_type": "status_code",
    "regex": "^[^.]*?$"
  },
  {
    "name": "fixya",
    "uri": "https://www.fixya.com/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "fl",
    "uri": "https://www.fl.ru/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "forum_guns",
    "uri": "https://forum.guns.ru/forummisc/blog/{username}",
    "error_type": "message",
    "error_msg": "action=https://forum.guns.ru/forummisc/blog/search"
  },
  {
    "name": "freecodecamp",
    "uri": "https://www.freecodecamp.org/{username}",
    "error_type": "status_code"
  },
  {
    "name": "furaffinity",
    "uri": "https://www.furaffinity.net/user/{username}",
    "error_type": "message",
    "error_msg": "This user cannot be found."
  },
  {
    "name": "geocaching",
    "uri": "https://www.geocaching.com/p/default.aspx?u={username}",
    "error_type": "status_code"
  },
  {
    "name": "habr",
    "uri": "https://habr.com/ru/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "hackster",
    "uri": "https://www.hackster.io/{username}",
    "error_type": "status_code"
  },
  {
    "name": "hunting",
    "uri": "https://www.hunting.ru/forum/members/?username={username}",
    "error_type": "message",
    "error_msg": "Указанный пользователь не найден. Пожалуйста, введите другое имя."
  },
  {
    "name": "igromania",
    "uri": "http://forum.igromania.ru/member.php?username={username}",
    "error_type": "message",
    "error_msg": "Пользователь не зарегистрирован и не имеет профиля для просмотра."
  },
  {
    "name": "interpals",
    "uri": "https://www.interpals.net/{username}",
    "error_type": "message",
    "error_msg": "The requested user does not exist or is inactive"
  },
  {
    "name": "irecommend",
    "uri": "https://irecommend.ru/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "jbzd.com.pl",
    "uri": "https://jbzd.com.pl/uzytkownik/{username}",
    "error_type": "status_code"
  },
  {
    "name": "jeuxvideo",
    "uri": "https://www.jeuxvideo.com/profil/{username}",
    "error_type": "status_code"
  },
  {
    "name": "kofi",
    "uri": "https://ko-fi.com/{username}",
    "error_type": "response_url"
  },
  {
    "name": "kwork",
    "uri": "https://kwork.ru/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "last.fm",
    "uri": "https://last.fm/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "leasehackr",
    "uri": "https://forum.leasehackr.com/u/{username}/summary/",
    "error_type": "status_code"
  },
  {
    "name": "livelib",
    "uri": "https://www.livelib.ru/reader/{username}",
    "error_type": "status_code"
  },
  {
    "name": "mastodon.cloud",
    "uri": "https://mastodon.cloud/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "mastodon.social",
    "uri": "https://mastodon.social/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "mastodon.xyz",
    "uri": "https://mastodon.xyz/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "mstdn.social",
    "uri": "https://mstdn.social/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "mercadolivre",
    "uri": "https://www.mercadolivre.com.br/perfil/{username}",
    "error_type": "status_code"
  },
  {
    "name": "minds",
    "uri": "https://www.minds.com/{username}/",
    "error_type": "message",
    "error_msg": "\"valid\":true"
  },
  {
    "name": "moikrug",
    "uri": "https://moikrug.ru/{username}",
    "error_type": "status_code"
  },
  {
    "name": "mstdn.io",
    "uri": "https://mstdn.io/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "nairaland.com",
    "uri": "https://www.nairaland.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "n8n Community",
    "uri": "https://community.n8n.io/u/{username}/summary",
    "error_type": "status_code"
  },
  {
    "name": "nnRU",
    "uri": "https://{username}.www.nn.ru/",
    "error_type": "status_code",
    "regex": "^[\\w@-]+?$"
  },
  {
    "name": "note",
    "uri": "https://note.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "npm",
    "uri": "https://www.npmjs.com/~{username}",
    "error_type": "status_code"
  },
  {
    "name": "omg.lol",
    "uri": "https://{username}.omg.lol",
    "error_type": "message",
    "error_msg": "\"available\": true"
  },
  {
    "name": "opennet",
    "uri": "https://www.opennet.ru/~{username}",
    "error_type": "message",
    "error_msg": "Имя участника не найдено",
    "regex": "^[^-]*$"
  },
  {
    "name": "osu!",
    "uri": "https://osu.ppy.sh/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "phpRU",
    "uri": "https://php.ru/forum/members/?username={username}",
    "error_type": "message",
    "error_msg": "Указанный пользователь не найден. Пожалуйста, введите другое имя."
  },
  {
    "name": "pikabu",
    "uri": "https://pikabu.ru/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "Pinterest",
    "uri": "https://www.pinterest.com/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "pr0gramm",
    "uri": "https://pr0gramm.com/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "prog.hu",
    "uri": "https://prog.hu/azonosito/info/{username}",
    "error_type": "response_url"
  },
  {
    "name": "satsisRU",
    "uri": "https://satsis.info/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "sessionize",
    "uri": "https://sessionize.com/{username}",
    "error_type": "status_code"
  },
  {
    "name": "social.tchncs.de",
    "uri": "https://social.tchncs.de/@{username}",
    "error_type": "status_code"
  },
  {
    "name": "spletnik",
    "uri": "https://spletnik.ru/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "svidbook",
    "uri": "https://www.svidbook.ru/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "threads",
    "uri": "https://www.threads.net/@{username}",
    "error_type": "message",
    "error_msg": "<title>Threads • Log in</title>"
  },
  {
    "name": "toster",
    "uri": "https://www.toster.ru/user/{username}/answers",
    "error_type": "status_code"
  },
  {
    "name": "tumblr",
    "uri": "https://{username}.tumblr.com/",
    "error_type": "status_code"
  },
  {
    "name": "uid",
    "uri": "http://uid.me/{username}",
    "error_type": "status_code"
  },
  {
    "name": "write.as",
    "uri": "https://write.as/{username}",
    "error_type": "status_code"
  },
  {
    "name": "xHamster",
    "uri": "https://xhamster.com/users/{username}",
    "error_type": "status_code"
  },
  {
    "name": "znanylekarz.pl",
    "uri": "https://www.znanylekarz.pl/{username}",
    "error_type": "status_code"
  },
  {
    "name": "Platzi",
    "uri": "https://platzi.com/p/{username}/",
    "error_type": "status_code"
  },
  {
    "name": "BabyRu",
    "uri": "https://www.baby.ru/u/{username}",
    "error_type": "message",
    "error_msg": "Страница, которую вы искали, не найдена"
  },
  {
    "name": "Wowhead",
    "uri": "https://wowhead.com/user={username}",
    "error_type": "status_code"
  },
  {
    "name": "addons.wago.io",
    "uri": "https://addons.wago.io/user/{username}",
    "error_type": "status_code"
  },
  {
    "name": "CurseForge",
    "uri": "https://www.curseforge.com/members/{username}/projects",
    "error_type": "status_code"
  }
];

// ────────────────────────────────────────────────────────────────
// HELPER: validasi username format (regex per-site)
// ────────────────────────────────────────────────────────────────
function usernameMatchesRegex(username, regexStr) {
  if (!regexStr) return true;
  try {
    return new RegExp(regexStr).test(username);
  } catch (_) {
    return true;
  }
}

// ────────────────────────────────────────────────────────────────
// HELPER: cek satu site
// ────────────────────────────────────────────────────────────────
async function checkSite(site, username) {
  // Skip jika username tidak cocok dengan regex site ini
  if (site.regex && !usernameMatchesRegex(username, site.regex)) {
    return { found: false };
  }
  const url = site.uri.replace(/{username}/g, encodeURIComponent(username));
  try {
    const resp = await axios.get(url, {
      timeout: 10000,
      maxRedirects: 3,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      validateStatus: () => true,
    });

    if (site.error_type === 'status_code') {
      if (resp.status >= 200 && resp.status < 300) return { found: true, url };
    } else if (site.error_type === 'message') {
      const body = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
      if (resp.status >= 200 && resp.status < 300 && !body.includes(site.error_msg)) {
        return { found: true, url };
      }
    } else if (site.error_type === 'response_url') {
      // Akun ada jika URL final tidak redirect ke halaman error
      if (resp.status >= 200 && resp.status < 300) return { found: true, url };
    }
  } catch (_) { /* timeout / network error */ }
  return { found: false };
}

// ────────────────────────────────────────────────────────────────
// MAIN: search username di semua site (paralel, batch 25)
// ────────────────────────────────────────────────────────────────
async function searchUsername(username, onProgress) {
  const found = [];
  const BATCH = 25;
  const total = SITES.length;
  let checked = 0;

  for (let i = 0; i < SITES.length; i += BATCH) {
    const batch = SITES.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(site => checkSite(site, username)));
    results.forEach((r, idx) => {
      if (r.found) found.push({ name: batch[idx].name, url: r.url });
    });
    checked += batch.length;
    if (onProgress) onProgress(checked, total, found.length);
  }

  return found;
}

module.exports = { searchUsername, SITES };
