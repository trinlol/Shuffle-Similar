// NAME: Shuffle Similar
// DESCRIPTION: Play songs similar to your seed, with optional progressive blend into your library
// VERSION: 1.7.0
// AUTHORS: Shuffle Similar Contributors

"use strict";
(() => {
  // src/storage/settings.ts
  var HISTORY_KEY = "shuffleSimilar:playHistory";
  var LEGACY_SIMILAR_SHUFFLE_HISTORY_KEY = "similarShuffle:playHistory";
  var LEGACY_BETTER_SHUFFLE_HISTORY_KEY = "betterShuffle:playHistory";
  var LEGACY_BETTER_SHUFFLE_STORAGE_KEY = "betterShuffle:settings";
  var LEGACY_SIMILAR_SHUFFLE_STORAGE_KEY = "similarShuffle:settings";
  var STORAGE_KEY = "shuffleSimilar:settings";
  var getSmartConfig = (seed) => {
    const releaseYear = seed?.releaseYear;
    const popularity = seed?.popularity;
    let eraWindow = 3;
    if (releaseYear) {
      if (releaseYear < 1980) eraWindow = 8;
      else if (releaseYear < 2e3) eraWindow = 5;
      else eraWindow = 3;
    }
    const deprioritizePopular = popularity == null || popularity < 75;
    return {
      eraWindow,
      artistSpacing: 3,
      refillThreshold: 3,
      initialQueueSize: 25,
      excludeSeedArtistEarly: true,
      historyPenaltyWindow: 200,
      deprioritizePopular,
      matchTempo: true,
      matchEnergy: true,
      matchValence: true,
      blendPhases: [
        { maxPosition: 4, similarWeight: 1, profileWeight: 0 },
        { maxPosition: 9, similarWeight: 0.7, profileWeight: 0.3 },
        { maxPosition: 19, similarWeight: 0.4, profileWeight: 0.6 },
        { maxPosition: Number.POSITIVE_INFINITY, similarWeight: 0.2, profileWeight: 0.8 }
      ]
    };
  };
  var migrateLegacyStorage = () => {
    const legacyKeys = [
      LEGACY_SIMILAR_SHUFFLE_STORAGE_KEY,
      LEGACY_BETTER_SHUFFLE_STORAGE_KEY,
      STORAGE_KEY
    ];
    for (const key of legacyKeys) {
      if (Spicetify.LocalStorage.get(key)) {
        Spicetify.LocalStorage.remove(key);
      }
    }
    const legacyHistoryKeys = [
      LEGACY_SIMILAR_SHUFFLE_HISTORY_KEY,
      LEGACY_BETTER_SHUFFLE_HISTORY_KEY
    ];
    for (const legacyKey of legacyHistoryKeys) {
      const legacyHistory = Spicetify.LocalStorage.get(legacyKey);
      if (legacyHistory && !Spicetify.LocalStorage.get(HISTORY_KEY)) {
        Spicetify.LocalStorage.set(HISTORY_KEY, legacyHistory);
        Spicetify.LocalStorage.remove(legacyKey);
        break;
      }
    }
  };
  var loadPlayHistory = () => {
    migrateLegacyStorage();
    try {
      const raw = Spicetify.LocalStorage.get(HISTORY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((uri) => typeof uri === "string") : [];
    } catch {
      return [];
    }
  };
  var appendPlayHistory = (uri, maxWindow) => {
    const history = loadPlayHistory().filter((entry) => entry !== uri);
    history.unshift(uri);
    Spicetify.LocalStorage.set(HISTORY_KEY, JSON.stringify(history.slice(0, maxWindow)));
  };

  // src/algorithm/shuffle.ts
  var fisherYatesShuffle = (array) => {
    const result = [...array];
    let counter = result.length;
    if (counter <= 1) return result;
    while (counter > 0) {
      const index = Math.floor(Math.random() * counter);
      counter -= 1;
      const temp = result[counter];
      result[counter] = result[index];
      result[index] = temp;
    }
    return result;
  };
  var pickRandom = (items) => {
    if (items.length === 0) return null;
    return items[Math.floor(Math.random() * items.length)];
  };
  var pickWeightedRandom = (items, weights) => {
    if (items.length === 0) return null;
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (total <= 0) return pickRandom(items);
    let roll = Math.random() * total;
    for (let index = 0; index < items.length; index += 1) {
      roll -= weights[index];
      if (roll <= 0) return items[index];
    }
    return items[items.length - 1];
  };
  var softShuffle = (array, jitter = 3) => {
    if (array.length <= 1) return [...array];
    const indexed = array.map((item, index) => ({
      item,
      sortKey: index + (Math.random() * 2 - 1) * jitter
    }));
    indexed.sort((a, b) => a.sortKey - b.sortKey);
    return indexed.map((entry) => entry.item);
  };
  var popularityWeight = (popularity, favorObscure, steepness = 2.5) => {
    const pop = Math.max(0, Math.min(100, popularity ?? 50));
    if (!favorObscure) return 1;
    const normalized = 1 - pop / 100;
    return Math.pow(normalized, 1) * steepness + 0.3;
  };

  // src/algorithm/filters.ts
  var dedupeCandidates = (candidates) => {
    const seen = /* @__PURE__ */ new Set();
    return candidates.filter((candidate) => {
      if (seen.has(candidate.uri)) return false;
      seen.add(candidate.uri);
      return true;
    });
  };
  var filterPlayableCandidates = (candidates) => {
    return candidates.filter((candidate) => Boolean(candidate.uri?.startsWith("spotify:track:")));
  };
  var excludeArtist = (candidates, artistUri, artistName) => {
    if (!artistUri && !artistName) return candidates;
    return candidates.filter((candidate) => {
      if (artistUri && candidate.artistUri === artistUri) return false;
      if (artistName && candidate.artistName === artistName) return false;
      return true;
    });
  };
  var computeHistoryWeights = (candidates, sessionPlayed, historyWindow) => {
    const recentHistory = [...sessionPlayed, ...loadPlayHistory().slice(0, historyWindow)];
    const positionMap = /* @__PURE__ */ new Map();
    for (let i = 0; i < recentHistory.length; i += 1) {
      if (!positionMap.has(recentHistory[i])) {
        positionMap.set(recentHistory[i], i);
      }
    }
    const weights = /* @__PURE__ */ new Map();
    for (const candidate of candidates) {
      const position = positionMap.get(candidate.uri);
      if (position === void 0) {
        weights.set(candidate.uri, 1);
      } else {
        const decay = Math.min(1, 0.05 + 0.95 * (1 - Math.exp(-position / 30)));
        weights.set(candidate.uri, decay);
      }
    }
    return weights;
  };
  var sortByObscurity = (candidates) => {
    return [...candidates].sort((a, b) => (a.popularity ?? 50) - (b.popularity ?? 50));
  };
  var respectsArtistSpacing = (candidate, recentArtists, spacing) => {
    if (!candidate.artistUri && !candidate.artistName) return true;
    const key = candidate.artistUri ?? candidate.artistName ?? "";
    return !recentArtists.slice(-spacing).includes(key);
  };
  var respectsAlbumSpacing = (candidate, recentAlbums, spacing) => {
    if (!candidate.albumUri) return true;
    return !recentAlbums.slice(-spacing).includes(candidate.albumUri);
  };
  var getRecentKeys = (played, spacing) => {
    const recent = played.slice(-spacing);
    return {
      artists: recent.map((track) => track.artistUri ?? track.artistName ?? "").filter(Boolean),
      albums: recent.map((track) => track.albumUri ?? "").filter(Boolean)
    };
  };
  var eraAffinityWeight = (candidate, seedYear, eraWindow) => {
    if (seedYear == null || candidate.releaseYear == null) return 1;
    const distance = Math.abs(candidate.releaseYear - seedYear);
    if (distance <= eraWindow) return 1.3;
    if (distance <= eraWindow * 2) return 1.1;
    return 1;
  };
  var pickFromPool = (pool, options) => {
    const { recentKeys, artistSpacing, albumSpacing, favorObscure, historyWeights, seedYear, eraWindow } = options;
    const eligible = pool.filter(
      (candidate) => respectsArtistSpacing(candidate, recentKeys.artists, artistSpacing) && respectsAlbumSpacing(candidate, recentKeys.albums, albumSpacing)
    );
    const artistOnly = eligible.length > 0 ? eligible : pool.filter((candidate) => respectsArtistSpacing(candidate, recentKeys.artists, artistSpacing));
    const pickPool = artistOnly.length > 0 ? artistOnly : pool;
    if (pickPool.length === 0) return null;
    const weights = pickPool.map((candidate) => {
      let weight = popularityWeight(candidate.popularity ?? 50, favorObscure);
      if (historyWeights) {
        weight *= historyWeights.get(candidate.uri) ?? 1;
      }
      if (seedYear != null && eraWindow != null) {
        weight *= eraAffinityWeight(candidate, seedYear, eraWindow);
      }
      return Math.max(0.01, weight);
    });
    return pickWeightedRandom(pickPool, weights);
  };

  // src/algorithm/progressiveBlend.ts
  var getBlendWeights = (position, settings) => {
    const phases = settings.blendPhases;
    const phase = phases.find((entry) => position <= entry.maxPosition) ?? phases[phases.length - 1];
    return {
      similarWeight: phase.similarWeight,
      profileWeight: phase.profileWeight
    };
  };
  var buildTrackBatch = (seed, position, sessionPlayedUris, similarPool, profilePool, settings, count) => {
    const { similarWeight, profileWeight } = getBlendWeights(position, settings);
    const playedSet = new Set(sessionPlayedUris);
    const excludeEarlyArtist = settings.excludeSeedArtistEarly && position <= 4;
    let similar = dedupeCandidates(filterPlayableCandidates(similarPool)).filter(
      (candidate) => !playedSet.has(candidate.uri)
    );
    let profile = dedupeCandidates(filterPlayableCandidates(profilePool)).filter(
      (candidate) => !playedSet.has(candidate.uri)
    );
    if (excludeEarlyArtist) {
      similar = excludeArtist(similar, seed.artistUri, seed.artistName);
      profile = excludeArtist(profile, seed.artistUri, seed.artistName);
    }
    const similarHistoryWeights = computeHistoryWeights(similar, sessionPlayedUris, settings.historyPenaltyWindow);
    const profileHistoryWeights = computeHistoryWeights(profile, sessionPlayedUris, settings.historyPenaltyWindow);
    const selected = [];
    const recentPlayed = [];
    const pickedSet = /* @__PURE__ */ new Set();
    const albumSpacing = 2;
    while (selected.length < count && (similar.length > 0 || profile.length > 0)) {
      const recentKeys = getRecentKeys(recentPlayed, settings.artistSpacing);
      const useSimilar = similar.length > 0 && (profile.length === 0 || Math.random() < similarWeight / (similarWeight + profileWeight));
      const pool = useSimilar ? similar : profile;
      const favorObscure = settings.deprioritizePopular;
      const historyWeights = useSimilar ? similarHistoryWeights : profileHistoryWeights;
      const picked = pickFromPool(pool, {
        recentKeys,
        artistSpacing: settings.artistSpacing,
        albumSpacing,
        favorObscure,
        historyWeights,
        seedYear: seed.releaseYear,
        eraWindow: settings.eraWindow
      });
      if (!picked) break;
      selected.push(picked);
      recentPlayed.push(picked);
      playedSet.add(picked.uri);
      pickedSet.add(picked.uri);
      if (useSimilar) {
        similar = similar.filter((candidate) => candidate.uri !== picked.uri);
      } else {
        profile = profile.filter((candidate) => candidate.uri !== picked.uri);
      }
      if (useSimilar) {
        profile = profile.filter((candidate) => candidate.uri !== picked.uri);
      } else {
        similar = similar.filter((candidate) => candidate.uri !== picked.uri);
      }
    }
    return softShuffle(selected, 3);
  };
  var buildSinglePoolBatch = (seed, pool, sessionPlayedUris, settings, count) => {
    const playedSet = new Set(sessionPlayedUris);
    let eligiblePool = pool.filter((track) => !playedSet.has(track.uri));
    if (eligiblePool.length === 0) {
      const recentHistory = sessionPlayedUris.slice(-settings.historyPenaltyWindow);
      playedSet.clear();
      recentHistory.forEach((uri) => playedSet.add(uri));
      eligiblePool = pool.filter((track) => !playedSet.has(track.uri));
    }
    const historyWeights = computeHistoryWeights(eligiblePool, sessionPlayedUris, settings.historyPenaltyWindow);
    const selected = [];
    const recentPlayed = [];
    const albumSpacing = 2;
    while (selected.length < count && eligiblePool.length > 0) {
      const recentKeys = getRecentKeys(recentPlayed, settings.artistSpacing);
      const favorObscure = settings.deprioritizePopular;
      const picked = pickFromPool(eligiblePool, {
        recentKeys,
        artistSpacing: settings.artistSpacing,
        albumSpacing,
        favorObscure,
        historyWeights,
        seedYear: seed?.releaseYear,
        eraWindow: settings.eraWindow
      });
      if (!picked) {
        const fallbackPicked = pickFromPool(eligiblePool, {
          recentKeys: { artists: [], albums: [] },
          artistSpacing: 0,
          albumSpacing: 0,
          favorObscure,
          historyWeights,
          seedYear: seed?.releaseYear,
          eraWindow: settings.eraWindow
        });
        if (!fallbackPicked) break;
        selected.push(fallbackPicked);
        recentPlayed.push(fallbackPicked);
        playedSet.add(fallbackPicked.uri);
        eligiblePool = eligiblePool.filter((track) => track.uri !== fallbackPicked.uri);
      } else {
        selected.push(picked);
        recentPlayed.push(picked);
        playedSet.add(picked.uri);
        eligiblePool = eligiblePool.filter((track) => track.uri !== picked.uri);
      }
    }
    return softShuffle(selected, 3);
  };

  // src/session/SessionManager.ts
  var state = {
    active: false,
    toggleEnabled: false,
    seed: null,
    playedUris: [],
    queuedUris: [],
    position: 0,
    similarPool: [],
    profilePool: [],
    isRefilling: false,
    playlistUri: null,
    playlistTracks: [],
    topTracksBlacklist: [],
    artistUri: null,
    artistTracks: []
  };
  var sessionManager = {
    isActive: () => state.active,
    isToggleEnabled: () => state.toggleEnabled,
    setToggleEnabled: (enabled) => {
      state.toggleEnabled = enabled;
    },
    getSeed: () => state.seed,
    getPosition: () => state.position,
    getPlayedUris: () => [...state.playedUris],
    getQueuedUris: () => [...state.queuedUris],
    getSimilarPool: () => state.similarPool,
    getProfilePool: () => state.profilePool,
    setPools: (similar, profile) => {
      state.similarPool = similar;
      state.profilePool = profile;
    },
    isRefilling: () => state.isRefilling,
    setRefilling: (value) => {
      state.isRefilling = value;
    },
    isPlaylistSession: () => Boolean(state.playlistUri),
    getPlaylistTracks: () => state.playlistTracks,
    getTopTracksBlacklist: () => state.topTracksBlacklist,
    isArtistSession: () => Boolean(state.artistUri),
    getArtistTracks: () => state.artistTracks,
    startSession: (seed) => {
      state.active = true;
      state.seed = seed;
      state.playedUris = [seed.uri];
      state.queuedUris = [];
      state.position = 0;
      state.similarPool = [];
      state.profilePool = [];
      state.playlistUri = null;
      state.playlistTracks = [];
      state.topTracksBlacklist = [];
      state.artistUri = null;
      state.artistTracks = [];
    },
    startPlaylistSession: (seed, playlistUri, playlistTracks, topTracks) => {
      state.active = true;
      state.seed = seed;
      state.playedUris = [seed.uri];
      state.queuedUris = [];
      state.position = 0;
      state.similarPool = [];
      state.profilePool = [];
      state.playlistUri = playlistUri;
      state.playlistTracks = playlistTracks;
      state.topTracksBlacklist = topTracks;
      state.artistUri = null;
      state.artistTracks = [];
    },
    startArtistSession: (seed, artistUri, artistTracks) => {
      state.active = true;
      state.seed = seed;
      state.playedUris = [seed.uri];
      state.queuedUris = [];
      state.position = 0;
      state.similarPool = [];
      state.profilePool = [];
      state.playlistUri = null;
      state.playlistTracks = [];
      state.topTracksBlacklist = [];
      state.artistUri = artistUri;
      state.artistTracks = artistTracks;
    },
    endSession: () => {
      state.active = false;
      state.seed = null;
      state.playedUris = [];
      state.queuedUris = [];
      state.position = 0;
      state.similarPool = [];
      state.profilePool = [];
      state.isRefilling = false;
      state.playlistUri = null;
      state.playlistTracks = [];
      state.topTracksBlacklist = [];
      state.artistUri = null;
      state.artistTracks = [];
    },
    recordTrackPlayed: (uri) => {
      if (!uri || uri === "spotify:delimiter") return;
      if (!state.playedUris.includes(uri)) {
        state.playedUris.push(uri);
      }
      state.position += 1;
      state.queuedUris = state.queuedUris.filter((queuedUri) => queuedUri !== uri);
      const config = getSmartConfig(state.seed);
      appendPlayHistory(uri, config.historyPenaltyWindow);
    },
    setQueuedUris: (uris) => {
      state.queuedUris = uris.filter((uri) => uri !== "spotify:delimiter");
    },
    ownsQueueTrack: (uri) => {
      if (!state.active) return false;
      if (state.seed?.uri === uri) return true;
      return state.queuedUris.includes(uri) || state.playedUris.includes(uri);
    }
  };

  // src/utils/uri.ts
  var getUriId = (uri) => {
    const uriObj = Spicetify.URI.fromString(uri);
    return uriObj._base62Id ?? uriObj.id ?? uri.split(":").pop() ?? "";
  };

  // src/utils/playability.ts
  var getMarket = () => {
    try {
      const locale = Spicetify.Locale.getLocale().replace("_", "-");
      const country = locale.split("-")[1];
      if (country) return country.toUpperCase();
    } catch {
    }
    return "GB";
  };
  var toTrackUri = (track) => {
    if (track.uri?.startsWith("spotify:track:")) return track.uri;
    if (track.id) return `spotify:track:${track.id}`;
    return null;
  };
  var isWebApiTrackPlayable = (track) => {
    const uri = track ? toTrackUri(track) : null;
    if (!uri) return false;
    return track?.is_playable !== false;
  };
  var filterPlayableUris = async (uris) => {
    const uniqueUris = [...new Set(uris.filter((uri) => uri.startsWith("spotify:track:")))];
    if (uniqueUris.length === 0) return [];
    const playableUris = /* @__PURE__ */ new Set();
    const market = getMarket();
    for (let offset = 0; offset < uniqueUris.length; offset += 50) {
      const chunk = uniqueUris.slice(offset, offset + 50);
      const ids = chunk.map(getUriId).filter(Boolean);
      if (ids.length === 0) {
        for (const uri of chunk) playableUris.add(uri);
        continue;
      }
      try {
        const response = await Spicetify.CosmosAsync.get(
          `https://api.spotify.com/v1/tracks?ids=${ids.join(",")}&market=${market}`
        );
        const tracks = response?.tracks ?? [];
        let matchedInChunk = 0;
        for (const track of tracks) {
          if (!isWebApiTrackPlayable(track)) continue;
          const uri = toTrackUri(track);
          if (!uri) continue;
          playableUris.add(uri);
          matchedInChunk += 1;
        }
        if (matchedInChunk === 0) {
          for (const uri of chunk) playableUris.add(uri);
        }
      } catch (error) {
        console.warn("[Shuffle Similar] playability check failed, keeping chunk", error);
        for (const uri of chunk) playableUris.add(uri);
      }
    }
    const validated = uniqueUris.filter((uri) => playableUris.has(uri));
    if (validated.length === 0) return uniqueUris;
    return validated;
  };

  // src/sources/trackMetadata.ts
  var parseYear = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const match = value.match(/\d{4}/);
      if (match) return Number(match[0]);
    }
    return void 0;
  };
  var candidateFromUri = (uri, metadata) => ({
    uri,
    artistUri: metadata?.artist_uri ?? metadata?.["artist_uri:1"],
    artistName: metadata?.artist_name ?? metadata?.["artist_name:1"],
    albumUri: metadata?.album_uri,
    albumName: metadata?.album_title ?? metadata?.album_name,
    trackName: metadata?.title ?? metadata?.name ?? metadata?.track_name,
    popularity: metadata?.popularity ? Number(metadata.popularity) : void 0,
    releaseYear: metadata?.release_year ? Number(metadata.release_year) : void 0
  });
  var fetchArtistGenres = async (artistId) => {
    if (!artistId) return [];
    try {
      const artist = await Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/artists/${artistId}`
      );
      return (artist?.genres ?? []).filter((genre) => typeof genre === "string");
    } catch {
      return [];
    }
  };
  var getSeedMetadataFromPlayer = (uri) => {
    const currentUri = Spicetify.Player.data?.item?.uri;
    const metadata = currentUri === uri ? Spicetify.Player.data?.item?.metadata ?? {} : {};
    const trackId = getUriId(uri);
    return {
      uri,
      trackId,
      trackName: metadata.title ?? "",
      artistName: metadata.artist_name ?? metadata["artist_name:1"] ?? "",
      artistUri: metadata.artist_uri ?? metadata["artist_uri:1"] ?? "",
      albumUri: metadata.album_uri,
      albumName: metadata.album_title ?? metadata.album_name,
      releaseYear: parseYear(metadata.release_year ?? metadata.album_year),
      genres: []
    };
  };
  var fetchSeedMetadata = async (uri) => {
    const base = getSeedMetadataFromPlayer(uri);
    try {
      const track = await Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/tracks/${base.trackId}?market=${getMarket()}`
      );
      const artist = track?.artists?.[0];
      const artistId = artist?.id ?? getUriId(artist?.uri ?? "");
      const genres = artistId ? await fetchArtistGenres(artistId) : [];
      const features = await Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/audio-features/${base.trackId}`
      ).catch(() => null);
      return enrichSeedMetadata({
        uri,
        trackId: base.trackId,
        trackName: track?.name ?? base.trackName,
        artistName: artist?.name ?? base.artistName,
        artistUri: artist?.uri ?? base.artistUri,
        albumUri: track?.album?.uri ?? base.albumUri,
        albumName: track?.album?.name ?? base.albumName,
        releaseYear: parseYear(track?.album?.release_date) ?? base.releaseYear,
        genres,
        instrumentalness: features?.instrumentalness ?? void 0
      });
    } catch {
      return enrichSeedMetadata(base);
    }
  };
  var enrichSeedMetadata = async (seed) => {
    if (!seed.albumUri) return seed;
    try {
      const { queryAlbumTracks } = Spicetify.GraphQL.Definitions;
      const { data, errors } = await Spicetify.GraphQL.Request(queryAlbumTracks, {
        uri: seed.albumUri,
        offset: 0,
        limit: 1
      });
      if (errors?.length) return seed;
      const album = data?.albumUnion;
      const releaseYear = parseYear(album?.date?.isoString ?? album?.date?.year);
      const albumName = album?.name;
      return {
        ...seed,
        albumName: albumName ?? seed.albumName,
        releaseYear: releaseYear ?? seed.releaseYear
      };
    } catch {
      return seed;
    }
  };
  var enrichCandidatesFromSearch = (items) => {
    const candidates = [];
    for (const item of items) {
      const track = item;
      const uri = track.uri ?? (track.id ? `spotify:track:${track.id}` : "");
      if (!uri || !isWebApiTrackPlayable(track)) continue;
      const artist = track.artists?.[0];
      candidates.push({
        uri,
        artistUri: artist?.uri ?? (artist?.id ? `spotify:artist:${artist.id}` : void 0),
        artistName: artist?.name,
        albumUri: track.album?.uri ?? (track.album?.id ? `spotify:album:${track.album.id}` : void 0),
        albumName: track.album?.name,
        trackName: track.name,
        popularity: track.popularity,
        releaseYear: parseYear(track.album?.release_date)
      });
    }
    return candidates;
  };

  // src/sources/profileTracks.ts
  var LIKED_TRACKS_PAGE_SIZE = 50;
  var LIKED_TRACKS_MAX = 200;
  var fetchLikedTracksFromWebApi = async () => {
    const candidates = [];
    let offset = 0;
    while (offset < LIKED_TRACKS_MAX) {
      const res = await Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/me/tracks?limit=${LIKED_TRACKS_PAGE_SIZE}&offset=${offset}`
      );
      const items = res?.items ?? [];
      if (items.length === 0) break;
      for (const item of items) {
        const track = item?.track;
        if (!track || !isWebApiTrackPlayable(track) || !track.uri) continue;
        candidates.push({
          uri: track.uri,
          artistUri: track.artists?.[0]?.uri,
          artistName: track.artists?.[0]?.name,
          popularity: track.popularity
        });
      }
      if (!res?.next) break;
      offset += LIKED_TRACKS_PAGE_SIZE;
    }
    return candidates;
  };
  var fetchLikedTracksFromCollection = async () => {
    const res = await Spicetify.CosmosAsync.get(
      "sp://core-collection/unstable/@/list/tracks/all?responseFormat=protobufJson"
    );
    return (res.item ?? []).filter((track) => track.trackMetadata?.playable).map(
      (track) => ({
        uri: track.trackMetadata?.link ?? "",
        artistUri: track.trackMetadata?.artistUri,
        artistName: track.trackMetadata?.artistName,
        popularity: track.trackMetadata?.popularity
      })
    ).filter((candidate) => Boolean(candidate.uri));
  };
  var fetchLikedTracks = async () => {
    try {
      return await fetchLikedTracksFromWebApi();
    } catch (webApiError) {
      console.warn("[Shuffle Similar] Web API liked songs failed, trying collection API", webApiError);
    }
    try {
      return await fetchLikedTracksFromCollection();
    } catch (collectionError) {
      console.warn("[Shuffle Similar] Collection API liked songs failed", collectionError);
      return [];
    }
  };
  var fetchPlaylistEntries = async () => {
    const root = await Spicetify.Platform.RootlistAPI.getContents();
    const playlists = [];
    const walk = (items) => {
      for (const item of items) {
        if (item.type === "playlist" && item.uri) {
          playlists.push({ uri: item.uri, name: item.name ?? item.uri });
        }
        if (item.items) walk(item.items);
      }
    };
    walk(root.items ?? []);
    return playlists;
  };
  var fetchPlaylistTracks = async (playlistUri) => {
    const playlistId = getUriId(playlistUri);
    if (!playlistId) return [];
    const res = await Spicetify.Platform.PlaylistAPI.getContents(`spotify:playlist:${playlistId}`, {
      limit: 100
    });
    return (res.items ?? []).filter((item) => item.uri && item.uri.startsWith("spotify:track:") && item.isPlayable !== false).map(
      (item) => candidateFromUri(item.uri, item.metadata)
    );
  };
  var fetchAllPlaylistTracks = async (playlistUri) => {
    const playlistId = getUriId(playlistUri);
    if (!playlistId) return [];
    const allTracks = [];
    let offset = 0;
    const limit = 100;
    try {
      while (true) {
        const res = await Spicetify.Platform.PlaylistAPI.getContents(`spotify:playlist:${playlistId}`, {
          limit,
          offset
        });
        const items = res?.items ?? [];
        if (items.length === 0) break;
        const tracks = items.filter((item) => item.uri && item.uri.startsWith("spotify:track:") && item.isPlayable !== false).map(
          (item) => candidateFromUri(item.uri, item.metadata)
        );
        allTracks.push(...tracks);
        if (items.length < limit || allTracks.length >= 2e3) {
          break;
        }
        offset += limit;
      }
    } catch (error) {
      console.warn("[Shuffle Similar] Failed to fetch all playlist tracks", error);
    }
    return allTracks;
  };
  var fetchTopTracks = async () => {
    const topTracks = [];
    try {
      const [shortTermRes, mediumTermRes] = await Promise.all([
        Spicetify.CosmosAsync.get("https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=short_term"),
        Spicetify.CosmosAsync.get("https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=medium_term")
      ]);
      const shortTermItems = shortTermRes?.items ?? [];
      const mediumTermItems = mediumTermRes?.items ?? [];
      for (const item of [...shortTermItems, ...mediumTermItems]) {
        if (item?.uri) {
          topTracks.push(item.uri);
        }
      }
    } catch (error) {
      console.warn("[Shuffle Similar] Failed to fetch top tracks", error);
    }
    return [...new Set(topTracks)];
  };
  var scorePlaylistName = (name, seed) => {
    const lower = name.toLowerCase();
    let score = 0;
    if (seed.artistName && lower.includes(seed.artistName.toLowerCase())) score += 2;
    for (const genre of seed.genres) {
      if (lower.includes(genre.toLowerCase())) score += 1;
    }
    return score;
  };
  var fetchProfilePool = async (seed) => {
    const [likedResult, playlistResult] = await Promise.allSettled([
      fetchLikedTracks(),
      fetchPlaylistEntries()
    ]);
    const liked = likedResult.status === "fulfilled" ? likedResult.value : [];
    const playlistEntries = playlistResult.status === "fulfilled" ? playlistResult.value : [];
    const sampledPlaylists = playlistEntries.map((entry) => ({ uri: entry.uri, score: scorePlaylistName(entry.name, seed) })).sort((a, b) => b.score - a.score).slice(0, 8).map((entry) => entry.uri);
    const playlistResults = await Promise.allSettled(
      sampledPlaylists.map((uri) => fetchPlaylistTracks(uri))
    );
    const playlistTracks = [];
    for (const result of playlistResults) {
      if (result.status === "fulfilled") playlistTracks.push(...result.value);
    }
    const shuffledLiked = sortByObscurity(liked).slice(0, 120);
    const shuffledPlaylist = sortByObscurity(playlistTracks).slice(0, 120);
    return dedupeCandidates([...shuffledLiked, ...shuffledPlaylist]).filter(
      (candidate) => candidate.uri !== seed.uri
    );
  };
  var pickSeedFromCollection = async (uris) => {
    if (uris.length === 0) return null;
    const firstUri = uris[0];
    const uriObj = Spicetify.URI.fromString(firstUri);
    const { Type } = Spicetify.URI;
    if (uriObj.type === Type.TRACK) {
      return firstUri;
    }
    switch (uriObj.type) {
      case Type.PLAYLIST:
      case Type.PLAYLIST_V2: {
        const tracks = await fetchPlaylistTracks(firstUri);
        const pick = pickRandom(tracks);
        if (!pick?.uri) {
          throw new Error("No playable tracks found in this playlist.");
        }
        return pick.uri;
      }
      case Type.ALBUM: {
        const { queryAlbumTracks } = Spicetify.GraphQL.Definitions;
        const { data } = await Spicetify.GraphQL.Request(queryAlbumTracks, {
          uri: firstUri,
          offset: 0,
          limit: 100
        });
        const items = (data?.albumUnion?.tracksV2 ?? data?.albumUnion?.tracks ?? []).items ?? [];
        const playable = items.map((item) => item.track).filter(
          (track) => Boolean(track?.playability?.playable && track.uri)
        );
        const pick = pickRandom(playable);
        if (!pick?.uri) {
          throw new Error("No playable tracks found in this album.");
        }
        return pick.uri;
      }
      case Type.ARTIST: {
        const { queryArtistOverview } = Spicetify.GraphQL.Definitions;
        const { data } = await Spicetify.GraphQL.Request(queryArtistOverview, {
          uri: firstUri,
          locale: Spicetify.Locale.getLocale(),
          includePrerelease: false
        });
        const topTracks = data?.artistUnion?.discography?.topTracks?.items ?? [];
        const playable = topTracks.map((item) => item.track).filter((track) => Boolean(track?.uri));
        const pick = pickRandom(playable);
        if (!pick?.uri) {
          throw new Error("No playable tracks found for this artist.");
        }
        return pick.uri;
      }
      default:
        return firstUri;
    }
  };

  // src/sources/similarTracks.ts
  var enrichAudioFeaturesAndMetadata = async (candidates) => {
    if (candidates.length === 0) return candidates;
    const ids = candidates.map((c) => getUriId(c.uri)).filter(Boolean);
    const featuresMap = /* @__PURE__ */ new Map();
    const featurePromises = [];
    const featureChunkSize = 100;
    for (let i = 0; i < ids.length; i += featureChunkSize) {
      const chunkIds = ids.slice(i, i + featureChunkSize);
      featurePromises.push(
        (async () => {
          try {
            const res = await Spicetify.CosmosAsync.get(
              `https://api.spotify.com/v1/audio-features?ids=${chunkIds.join(",")}`
            );
            const audioFeatures = res?.audio_features ?? [];
            for (const feat of audioFeatures) {
              if (feat?.id) {
                featuresMap.set(`spotify:track:${feat.id}`, {
                  instrumentalness: feat.instrumentalness
                });
              }
            }
          } catch (error) {
            console.warn("[Shuffle Similar] Failed to fetch audio features chunk", error);
          }
        })()
      );
    }
    const metadataMap = /* @__PURE__ */ new Map();
    const metadataPromises = [];
    const metadataChunkSize = 50;
    const needsMetadata = candidates.filter((c) => !c.albumName || !c.trackName || c.popularity === void 0);
    const needsMetadataIds = needsMetadata.map((c) => getUriId(c.uri)).filter(Boolean);
    for (let i = 0; i < needsMetadataIds.length; i += metadataChunkSize) {
      const chunkIds = needsMetadataIds.slice(i, i + metadataChunkSize);
      metadataPromises.push(
        (async () => {
          try {
            const res = await Spicetify.CosmosAsync.get(
              `https://api.spotify.com/v1/tracks?ids=${chunkIds.join(",")}`
            );
            const tracks = res?.tracks ?? [];
            for (const track of tracks) {
              if (track?.id) {
                metadataMap.set(`spotify:track:${track.id}`, {
                  albumName: track.album?.name,
                  trackName: track.name,
                  popularity: track.popularity
                });
              }
            }
          } catch (error) {
            console.warn("[Shuffle Similar] Failed to fetch track metadata chunk", error);
          }
        })()
      );
    }
    await Promise.allSettled([...featurePromises, ...metadataPromises]);
    return candidates.map((candidate) => {
      const feat = featuresMap.get(candidate.uri);
      const meta = metadataMap.get(candidate.uri);
      return {
        ...candidate,
        instrumentalness: feat?.instrumentalness ?? candidate.instrumentalness,
        albumName: meta?.albumName ?? candidate.albumName,
        trackName: meta?.trackName ?? candidate.trackName,
        popularity: meta?.popularity ?? candidate.popularity
      };
    });
  };
  var filterInstrumentalsAndSoundtracks = (candidates, isVocal, isSoundtrack) => {
    return candidates.filter((candidate) => {
      if (isVocal && candidate.instrumentalness !== void 0 && candidate.instrumentalness > 0.5) {
        console.log(`[Shuffle Similar] Filtered out instrumental track: ${candidate.trackName} (instrumentalness: ${candidate.instrumentalness})`);
        return false;
      }
      if (!isSoundtrack && candidate.albumName) {
        const isCandidateSoundtrack = /(Soundtrack|Score|OST|Original Motion Picture|Original Soundtrack|Broadway|Musical)/i.test(
          candidate.albumName
        );
        if (isCandidateSoundtrack) {
          const isDisneyOrVocalPopException = isVocal && candidate.instrumentalness !== void 0 && candidate.instrumentalness < 0.2 && candidate.popularity !== void 0 && candidate.popularity >= 60;
          if (isDisneyOrVocalPopException) {
            console.log(`[Shuffle Similar] Kept vocal soundtrack exception: ${candidate.trackName} (popularity: ${candidate.popularity})`);
            return true;
          }
          console.log(`[Shuffle Similar] Filtered out soundtrack leakage track: ${candidate.trackName} (album: ${candidate.albumName})`);
          return false;
        }
      }
      return true;
    });
  };
  var fetchPlaylistCandidates = async (playlistUri) => {
    try {
      const playlistId = getUriId(playlistUri);
      const res = await Spicetify.Platform.PlaylistAPI.getContents(`spotify:playlist:${playlistId}`, {
        limit: 100
      });
      return (res.items ?? []).filter((item) => item.uri && item.uri.startsWith("spotify:track:") && item.isPlayable !== false).map(
        (item) => candidateFromUri(item.uri, item.metadata)
      );
    } catch {
      return [];
    }
  };
  var fetchInspiredByMix = async (seedUri) => {
    try {
      const response = await Spicetify.CosmosAsync.get(
        `https://spclient.wg.spotify.com/inspiredby-mix/v2/seed_to_playlist/${seedUri}?response-format=json`
      );
      const playlistUri = response?.mediaItems?.[0]?.uri;
      if (!playlistUri) return [];
      return fetchPlaylistCandidates(playlistUri);
    } catch {
      return [];
    }
  };
  var fetchRadioStationCandidates = async (seedUri) => {
    try {
      const radioUri = Spicetify.URI.radioURI(seedUri);
      const { fetchTracksForRadioStation } = Spicetify.GraphQL.Definitions;
      const { data, errors } = await Spicetify.GraphQL.Request(fetchTracksForRadioStation, {
        uri: radioUri.toString(),
        limit: 50
      });
      if (errors?.length) return [];
      const tracks = data?.radioStation?.tracks?.items ?? data?.mediaItems ?? [];
      const candidates = [];
      for (const item of tracks) {
        const entry = item;
        const track = entry.track ?? entry;
        const uri = track.uri;
        if (!uri) continue;
        const artist = "artists" in track ? track.artists?.items?.[0] : void 0;
        candidates.push({
          uri,
          artistUri: artist?.uri,
          artistName: artist?.profile?.name
        });
      }
      return candidates;
    } catch {
      return [];
    }
  };
  var searchTracks = async (query, limit = 50) => {
    const market = getMarket();
    const offset = Math.floor(Math.random() * 150);
    const response = await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}&offset=${offset}&market=${market}`
    );
    return enrichCandidatesFromSearch(response?.tracks?.items ?? []);
  };
  var buildEraQuery = (seed, settings) => {
    if (seed.releaseYear == null) return null;
    const start = Math.max(1900, seed.releaseYear - settings.eraWindow);
    const end = seed.releaseYear + settings.eraWindow;
    return `year:${start}-${end}`;
  };
  var fetchGenreEraCandidates = async (seed, settings) => {
    const eraQuery = buildEraQuery(seed, settings);
    const genre = seed.genres[0];
    if (!genre && !eraQuery) return [];
    const parts = [];
    if (genre) parts.push(`genre:"${genre}"`);
    if (eraQuery) parts.push(eraQuery);
    if (parts.length === 0) return [];
    return searchTracks(parts.join(" "));
  };
  var fetchEraOnlyCandidates = async (seed, settings) => {
    const eraQuery = buildEraQuery(seed, settings);
    if (!eraQuery) return [];
    return searchTracks(eraQuery);
  };
  var fetchRelatedArtistCandidates = async (seed) => {
    const artistId = getUriId(seed.artistUri);
    if (!artistId) return [];
    try {
      const related = await Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/artists/${artistId}/related-artists`
      );
      const artists = (related?.artists ?? []).slice(0, 6);
      const results = await Promise.allSettled(
        artists.filter((artist) => artist.name && artist.name !== seed.artistName).map((artist) => searchTracks(`artist:"${artist.name}"`, 20))
      );
      const merged = [];
      for (const result of results) {
        if (result.status === "fulfilled") merged.push(...result.value);
      }
      return merged;
    } catch {
      return [];
    }
  };
  var fetchAlbumPeerCandidates = async (seed) => {
    if (!seed.albumUri) return [];
    try {
      const { queryAlbumTracks } = Spicetify.GraphQL.Definitions;
      const { data } = await Spicetify.GraphQL.Request(queryAlbumTracks, {
        uri: seed.albumUri,
        offset: 0,
        limit: 50
      });
      const items = (data?.albumUnion?.tracksV2 ?? data?.albumUnion?.tracks ?? []).items ?? [];
      const albumTracks = [];
      for (const item of items) {
        const track = item.track;
        if (!track?.playability?.playable || !track.uri || track.uri === seed.uri) continue;
        albumTracks.push({
          uri: track.uri,
          artistUri: track.artists?.items?.[0]?.uri,
          artistName: track.artists?.items?.[0]?.profile?.name,
          albumUri: seed.albumUri,
          popularity: track.popularity
        });
      }
      return albumTracks;
    } catch {
      return [];
    }
  };
  var fetchAudioFeatures = async (trackId) => {
    try {
      const response = await Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/audio-features/${trackId}`
      );
      return {
        tempo: response?.tempo,
        energy: response?.energy,
        valence: response?.valence
      };
    } catch (error) {
      console.warn("[Shuffle Similar] Failed to fetch audio features", error);
      return null;
    }
  };
  var fetchRecommendations = async (seed, settings, limit = 50) => {
    try {
      const trackId = seed.trackId;
      const artistId = getUriId(seed.artistUri);
      if (!trackId) return [];
      const market = getMarket();
      let url = `https://api.spotify.com/v1/recommendations?limit=${limit}&market=${market}&seed_tracks=${trackId}`;
      if (artistId) {
        url += `&seed_artists=${artistId}`;
      }
      if (settings.deprioritizePopular) {
        url += `&max_popularity=70`;
      }
      const needsFeatures = settings.matchTempo || settings.matchEnergy || settings.matchValence;
      if (needsFeatures) {
        const features = await fetchAudioFeatures(trackId);
        if (features) {
          if (settings.matchTempo && features.tempo != null) {
            url += `&target_tempo=${features.tempo}`;
          }
          if (settings.matchEnergy && features.energy != null) {
            url += `&target_energy=${features.energy}`;
          }
          if (settings.matchValence && features.valence != null) {
            url += `&target_valence=${features.valence}`;
          }
        }
      }
      const response = await Spicetify.CosmosAsync.get(url);
      return enrichCandidatesFromSearch(response?.tracks ?? []);
    } catch (error) {
      console.warn("[Shuffle Similar] v1/recommendations failed", error);
      return [];
    }
  };
  var fetchSimilarPool = async (seed, settings) => {
    const results = await Promise.allSettled([
      fetchRecommendations(seed, settings, 50),
      fetchInspiredByMix(seed.uri),
      fetchRadioStationCandidates(seed.uri),
      fetchGenreEraCandidates(seed, settings),
      fetchEraOnlyCandidates(seed, settings),
      fetchRelatedArtistCandidates(seed),
      fetchAlbumPeerCandidates(seed)
    ]);
    const merged = [];
    for (const result of results) {
      if (result.status === "fulfilled") merged.push(...result.value);
    }
    let candidates = dedupeCandidates(merged).filter((candidate) => candidate.uri !== seed.uri).filter((candidate) => candidate.uri.startsWith("spotify:track:"));
    candidates = excludeArtist(candidates, seed.artistUri, seed.artistName);
    if (candidates.length < 10 && seed.artistName) {
      const fallback = await searchTracks(`year:${seed.releaseYear ?? 2010}`, 50);
      candidates = dedupeCandidates([
        ...candidates,
        ...excludeArtist(fallback, seed.artistUri, seed.artistName)
      ]);
    }
    candidates = await enrichAudioFeaturesAndMetadata(candidates);
    const isSeedSoundtrack = seed.albumName && /(Soundtrack|Score|OST|Original Motion Picture|Original Soundtrack|Broadway|Musical)/i.test(
      seed.albumName
    ) || seed.genres.some(
      (genre) => /(soundtrack|score|orchestral|movie tunes|show tunes|broadway|musical)/i.test(genre)
    );
    const isSeedVocal = seed.instrumentalness === void 0 || seed.instrumentalness < 0.2;
    console.info(
      `[Shuffle Similar] Seed "${seed.trackName}" analysis: isSeedVocal = ${isSeedVocal}, isSeedSoundtrack = ${isSeedSoundtrack}`
    );
    candidates = filterInstrumentalsAndSoundtracks(candidates, isSeedVocal, isSeedSoundtrack);
    return candidates.filter((candidate) => candidate.uri !== seed.uri);
  };
  var fetchPlaylistRecommendations = async (seeds, settings, limit = 50) => {
    try {
      const seedTrackIds = seeds.map((s) => getUriId(s.uri)).filter(Boolean);
      if (seedTrackIds.length === 0) return [];
      const market = getMarket();
      let url = `https://api.spotify.com/v1/recommendations?limit=${limit}&market=${market}&seed_tracks=${seedTrackIds.join(
        ","
      )}`;
      if (settings.deprioritizePopular) {
        url += `&max_popularity=70`;
      }
      const needsFeatures = settings.matchTempo || settings.matchEnergy || settings.matchValence;
      if (needsFeatures) {
        const features = await fetchAudioFeatures(seedTrackIds[0]);
        if (features) {
          if (settings.matchTempo && features.tempo != null) {
            url += `&target_tempo=${features.tempo}`;
          }
          if (settings.matchEnergy && features.energy != null) {
            url += `&target_energy=${features.energy}`;
          }
          if (settings.matchValence && features.valence != null) {
            url += `&target_valence=${features.valence}`;
          }
        }
      }
      const response = await Spicetify.CosmosAsync.get(url);
      return enrichCandidatesFromSearch(response?.tracks ?? []);
    } catch (error) {
      console.warn("[Shuffle Similar] Failed to fetch playlist recommendations", error);
      return [];
    }
  };
  var fetchPlaylistSimilarPool = async (playlistTracks, settings, seedCount = 3) => {
    if (playlistTracks.length === 0) return [];
    const playlistUriSet = new Set(playlistTracks.map((t) => t.uri));
    const seeds = sampleSpread(playlistTracks, Math.min(seedCount, playlistTracks.length));
    const seedMetadatas = await Promise.all(
      seeds.map((s) => buildSeedMetadataFromCandidate(s))
    );
    const poolResults = await Promise.allSettled(
      seedMetadatas.map((seed) => fetchSimilarPool(seed, settings))
    );
    const recoResult = await Promise.allSettled([
      fetchPlaylistRecommendations(seeds, settings, settings.initialQueueSize * 2)
    ]);
    const merged = [];
    for (const result of poolResults) {
      if (result.status === "fulfilled") merged.push(...result.value);
    }
    for (const result of recoResult) {
      if (result.status === "fulfilled") merged.push(...result.value);
    }
    let deduped = dedupeCandidates(merged).filter((c) => c.uri.startsWith("spotify:track:")).filter((c) => !playlistUriSet.has(c.uri));
    deduped = await enrichAudioFeaturesAndMetadata(deduped);
    const vocalCount = seedMetadatas.filter((s) => s.instrumentalness === void 0 || s.instrumentalness < 0.2).length;
    const isPlaylistVocal = vocalCount >= seedMetadatas.length / 2;
    const isPlaylistSoundtrack = seedMetadatas.some((s) => {
      const isSoundtrackAlbum = s.albumName && /(Soundtrack|Score|OST|Original Motion Picture|Original Soundtrack|Broadway|Musical)/i.test(s.albumName);
      const isSoundtrackGenre = s.genres.some((g) => /(soundtrack|score|orchestral|movie tunes|show tunes|broadway|musical)/i.test(g));
      return isSoundtrackAlbum || isSoundtrackGenre;
    });
    console.info(
      `[Shuffle Similar] Playlist analysis: isPlaylistVocal = ${isPlaylistVocal} (${vocalCount}/${seedMetadatas.length}), isPlaylistSoundtrack = ${isPlaylistSoundtrack}`
    );
    deduped = filterInstrumentalsAndSoundtracks(deduped, isPlaylistVocal, isPlaylistSoundtrack);
    console.info(
      `[Shuffle Similar] Playlist similar pool: ${deduped.length} candidates from ${seedMetadatas.length} seeds`
    );
    return deduped;
  };
  var sampleSpread = (items, count) => {
    if (count >= items.length) return [...items];
    const step = items.length / count;
    const result = [];
    for (let i = 0; i < count; i++) {
      const index = Math.min(Math.floor(i * step + Math.random() * step), items.length - 1);
      result.push(items[index]);
    }
    return result;
  };
  var buildSeedMetadataFromCandidate = async (candidate) => {
    const trackId = getUriId(candidate.uri);
    const artistId = candidate.artistUri ? getUriId(candidate.artistUri) : "";
    let genres = [];
    if (artistId) {
      try {
        const artist = await Spicetify.CosmosAsync.get(
          `https://api.spotify.com/v1/artists/${artistId}`
        );
        genres = (artist?.genres ?? []).filter((g) => typeof g === "string");
      } catch {
      }
    }
    let albumName = candidate.albumName;
    let instrumentalness = candidate.instrumentalness;
    try {
      if (!albumName) {
        const track = await Spicetify.CosmosAsync.get(
          `https://api.spotify.com/v1/tracks/${trackId}?market=${getMarket()}`
        );
        albumName = track?.album?.name;
      }
      const features = await Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/audio-features/${trackId}`
      );
      instrumentalness = features?.instrumentalness ?? void 0;
    } catch {
    }
    return {
      uri: candidate.uri,
      trackId,
      trackName: "",
      artistName: candidate.artistName ?? "",
      artistUri: candidate.artistUri ?? "",
      albumUri: candidate.albumUri,
      albumName,
      releaseYear: candidate.releaseYear,
      genres,
      instrumentalness
    };
  };

  // src/queue/queueManager.ts
  var formatQueueTrack = (uri) => ({
    contextTrack: {
      uri,
      uid: "",
      metadata: {
        is_queued: "false"
      }
    },
    removed: [],
    blocked: [],
    provider: "context"
  });
  var wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var isPlaylistContext = (uri) => {
    if (!uri) return false;
    try {
      const { Type } = Spicetify.URI;
      const type = Spicetify.URI.fromString(uri).type;
      return type === Type.PLAYLIST || type === Type.PLAYLIST_V2;
    } catch {
      return false;
    }
  };
  var isArtistContext = (uri) => {
    if (!uri) return false;
    try {
      const { Type } = Spicetify.URI;
      const type = Spicetify.URI.fromString(uri).type;
      return type === Type.ARTIST;
    } catch {
      return false;
    }
  };
  var isAlbumContext = (uri) => {
    if (!uri) return false;
    try {
      const { Type } = Spicetify.URI;
      const type = Spicetify.URI.fromString(uri).type;
      return type === Type.ALBUM;
    } catch {
      return false;
    }
  };
  var isValidPlaybackContext = (uri) => {
    if (!uri) return false;
    try {
      const { Type } = Spicetify.URI;
      const type = Spicetify.URI.fromString(uri).type;
      return type === Type.PLAYLIST || type === Type.PLAYLIST_V2 || type === Type.ALBUM || type === Type.ARTIST;
    } catch {
      return false;
    }
  };
  var resolveShuffleSimilarPlaybackContext = (contextUri, albumUri) => {
    if (contextUri && !isPlaylistContext(contextUri) && !isArtistContext(contextUri) && isValidPlaybackContext(contextUri)) {
      return { uri: contextUri, url: `context://${contextUri}` };
    }
    if (albumUri) {
      try {
        const { Type } = Spicetify.URI;
        const type = Spicetify.URI.fromString(albumUri).type;
        if (type === Type.ALBUM) {
          return { uri: albumUri, url: `context://${albumUri}` };
        }
      } catch {
      }
    }
    return null;
  };
  var detachFromPlaylistContext = async (albumUri) => {
    const currentContextUri = Spicetify.Player.data?.context?.uri;
    if (!isPlaylistContext(currentContextUri) && !isArtistContext(currentContextUri)) return;
    const fallback = resolveShuffleSimilarPlaybackContext(null, albumUri);
    if (!fallback) return;
    try {
      const sessionId = Spicetify.Platform.PlayerAPI.getState().sessionId;
      await Spicetify.Platform.PlayerAPI.updateContext(sessionId, {
        uri: fallback.uri,
        url: fallback.url
      });
    } catch (error) {
      console.warn("[Shuffle Similar] Could not switch away from playlist context", error);
    }
  };
  var getUpcomingQueueUris = () => {
    try {
      const queue = Spicetify.Platform.PlayerAPI._queue?._queueState;
      if (!queue) return [];
      const nextUp = (queue.nextUp ?? []).map((track) => track.uri);
      const queued = (queue.queued ?? []).map((track) => track.uri);
      return [.../* @__PURE__ */ new Set([...nextUp, ...queued])].filter((uri) => uri !== "spotify:delimiter");
    } catch {
      return [];
    }
  };
  var getUpcomingCount = () => getUpcomingQueueUris().length;
  var getQueueClient = () => {
    try {
      const playerQueue = Spicetify.Platform.PlayerAPI._queue;
      if (!playerQueue?._client?.setQueue) return null;
      return {
        client: playerQueue._client,
        prevTracks: playerQueue._queue?.prevTracks ?? [],
        queueRevision: Spicetify.Queue?.queueRevision ?? playerQueue._queue?.queueRevision
      };
    } catch {
      return null;
    }
  };
  var disableNativeShuffle = () => {
    try {
      if (Spicetify.Player.getShuffle?.()) {
        Spicetify.Player.setShuffle(false);
      }
    } catch {
    }
  };
  var clearQueueSafe = async () => {
    try {
      await Spicetify.Platform.PlayerAPI.clearQueue();
    } catch {
    }
  };
  var addTracksSafe = async (uris) => {
    const items = uris.filter((uri) => uri.startsWith("spotify:track:")).map((uri) => ({ uri }));
    if (items.length === 0) return;
    disableNativeShuffle();
    await Spicetify.Platform.PlayerAPI.addToQueue(items);
  };
  var setQueueSafe = async (uris, resetPrevTracks = false) => {
    const tracks = uris.filter((uri) => uri?.startsWith("spotify:track:"));
    if (tracks.length === 0) return false;
    const withDelimiter = [...tracks, "spotify:delimiter"];
    disableNativeShuffle();
    const queueClient = getQueueClient();
    if (!queueClient) return false;
    try {
      queueClient.client.setQueue({
        nextTracks: withDelimiter.map(formatQueueTrack),
        prevTracks: resetPrevTracks ? [] : queueClient.prevTracks,
        queueRevision: Spicetify.Queue?.queueRevision ?? queueClient.queueRevision
      });
      return true;
    } catch (error) {
      console.warn("[Shuffle Similar] setQueue failed", error);
      return false;
    }
  };
  var appendTracksToQueue = async (candidates) => {
    const uris = candidates.map((candidate) => candidate.uri).filter((uri) => uri.startsWith("spotify:track:"));
    await addTracksSafe(uris);
  };
  var playTrack = async (seedUri, playbackContext) => {
    if (!seedUri.startsWith("spotify:track:")) {
      throw new Error("Invalid track URI");
    }
    const track = { uri: seedUri };
    const context = playbackContext ?? {};
    await Spicetify.Platform.PlayerAPI.play(track, context, {});
  };
  var replaceUpcomingQueue = async (currentUri, upcomingUris) => {
    await clearQueueSafe();
    const tracks = upcomingUris.filter((uri) => uri.startsWith("spotify:track:")).filter((uri) => !currentUri || uri !== currentUri);
    if (tracks.length === 0) return;
    const usedSetQueue = await setQueueSafe(tracks, false);
    if (usedSetQueue) return;
    await addTracksSafe(tracks);
  };
  var playSeedAndQueue = async (seedUri, queueUris, playbackContext) => {
    const upcoming = queueUris.filter((uri) => uri !== seedUri && uri.startsWith("spotify:track:"));
    await playTrack(seedUri, playbackContext);
    let attempts = 0;
    while (Spicetify.Player.data?.item?.uri !== seedUri && attempts < 15) {
      await wait(100);
      attempts++;
    }
    await replaceUpcomingQueue(seedUri, upcoming);
  };
  var shuffleUpcomingInPlace = async () => {
    const currentUri = Spicetify.Player.data?.item?.uri ?? null;
    const upcoming = getUpcomingQueueUris().filter((uri) => uri.startsWith("spotify:track:"));
    if (upcoming.length === 0) return false;
    const shuffled = fisherYatesShuffle(upcoming);
    await replaceUpcomingQueue(currentUri, shuffled);
    return true;
  };

  // src/queue/autoplayGuard.ts
  var lastKnownQueue = "";
  var guardEnabled = false;
  var serializeQueue = (uris) => uris.join("|");
  var enableAutoplayGuard = () => {
    guardEnabled = true;
  };
  var disableAutoplayGuard = () => {
    guardEnabled = false;
    lastKnownQueue = "";
  };
  var syncKnownQueue = (uris) => {
    lastKnownQueue = serializeQueue(uris);
  };
  var detectForeignInjection = () => {
    if (!guardEnabled || !sessionManager.isActive()) return [];
    const current = getUpcomingQueueUris();
    if (!lastKnownQueue) {
      lastKnownQueue = serializeQueue(current);
      return [];
    }
    const previous = lastKnownQueue.split("|").filter(Boolean);
    const foreign = current.filter((uri) => !sessionManager.ownsQueueTrack(uri));
    if (foreign.length === 0) {
      lastKnownQueue = serializeQueue(current);
      return [];
    }
    const cleaned = current.filter((uri) => sessionManager.ownsQueueTrack(uri));
    lastKnownQueue = serializeQueue(cleaned.length > 0 ? cleaned : previous);
    return foreign;
  };

  // src/ui/playbarControls.ts
  var SHUFFLE_SIMILAR_TEST_ID = "shuffle-similar-button";
  var LEGACY_EXTENSION_TEST_IDS = ["better-shuffle-button", "similar-shuffle-button"];
  var LEGACY_EXTENSION_LABELS = ["Better Shuffle", "Similar Shuffle"];
  var isLegacyExtensionButton = (button) => {
    const testId = button.getAttribute("data-testid");
    if (testId && LEGACY_EXTENSION_TEST_IDS.includes(testId)) {
      return true;
    }
    const label = button.getAttribute("aria-label") ?? "";
    return LEGACY_EXTENSION_LABELS.includes(label);
  };
  var removeLegacyExtensionButtons = () => {
    let removed = 0;
    for (const testId of LEGACY_EXTENSION_TEST_IDS) {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (element) {
        element.remove();
        removed += 1;
      }
    }
    const playbar = document.querySelector('[data-testid="now-playing-bar"]') ?? document.querySelector(".main-nowPlayingBar-nowPlayingBar");
    if (playbar) {
      const buttons = playbar.querySelectorAll("button");
      for (let index = 0; index < buttons.length; index += 1) {
        const button = buttons.item(index);
        if (!(button instanceof HTMLButtonElement)) continue;
        if (isLegacyExtensionButton(button)) {
          button.remove();
          removed += 1;
        }
      }
    }
    if (removed > 0) {
      console.warn(
        `[Shuffle Similar] Removed ${removed} legacy playbar button(s). Delete better-shuffle.js and similar-shuffle.js from your Extensions folder.`
      );
    }
    return removed;
  };
  var legacyButtonObserver = null;
  var watchForLegacyExtensionButtons = () => {
    removeLegacyExtensionButtons();
    if (legacyButtonObserver) return;
    const shuffleButton = findNativeShuffleButton();
    const parent = shuffleButton?.parentElement;
    if (!parent) return;
    legacyButtonObserver = new MutationObserver(() => {
      removeLegacyExtensionButtons();
    });
    legacyButtonObserver.observe(parent, { childList: true, subtree: true });
  };
  var NATIVE_SHUFFLE_SELECTORS = [
    `button[data-testid="control-button-shuffle"]:not([data-testid="${SHUFFLE_SIMILAR_TEST_ID}"]):not([data-testid="better-shuffle-button"]):not([data-testid="similar-shuffle-button"])`,
    `.main-shuffleButton-button:not([data-testid="${SHUFFLE_SIMILAR_TEST_ID}"]):not([data-testid="better-shuffle-button"]):not([data-testid="similar-shuffle-button"])`
  ];
  var isShuffleSimilarButton = (element) => element instanceof HTMLButtonElement && element.getAttribute("data-testid") === SHUFFLE_SIMILAR_TEST_ID;
  var isNativeShuffleLabel = (label) => {
    const normalized = label.toLowerCase();
    if (!normalized.includes("shuffle")) return false;
    if (normalized.includes("smart")) return false;
    if (normalized.includes("similar")) return false;
    if (normalized.includes("better")) return false;
    return true;
  };
  var findNativeShuffleButton = () => {
    for (const selector of NATIVE_SHUFFLE_SELECTORS) {
      const element = document.querySelector(selector);
      if (element instanceof HTMLButtonElement && !isShuffleSimilarButton(element)) {
        return element;
      }
    }
    const playPause = document.querySelector('button[data-testid="control-button-playpause"]');
    const controlGroup = playPause?.parentElement;
    if (controlGroup) {
      const byTestId = controlGroup.querySelector('button[data-testid="control-button-shuffle"]');
      if (byTestId instanceof HTMLButtonElement && !isShuffleSimilarButton(byTestId)) {
        return byTestId;
      }
    }
    const playbar = document.querySelector('[data-testid="now-playing-bar"]') ?? document.querySelector(".main-nowPlayingBar-nowPlayingBar");
    if (playbar) {
      const buttons = playbar.querySelectorAll("button");
      for (let index = 0; index < buttons.length; index += 1) {
        const button = buttons.item(index);
        if (!(button instanceof HTMLButtonElement)) continue;
        if (isShuffleSimilarButton(button)) continue;
        if (isLegacyExtensionButton(button)) continue;
        const label = button.getAttribute("aria-label") ?? "";
        if (isNativeShuffleLabel(label)) {
          return button;
        }
      }
    }
    return null;
  };
  var isNativeShuffleTarget = (target) => {
    if (!(target instanceof Element)) return false;
    if (isShuffleSimilarButton(target) || target.closest(`[data-testid="${SHUFFLE_SIMILAR_TEST_ID}"]`)) {
      return false;
    }
    const shuffle = findNativeShuffleButton();
    if (shuffle && (target === shuffle || shuffle.contains(target))) return true;
    return Boolean(target.closest(NATIVE_SHUFFLE_SELECTORS.join(", ")));
  };
  var placeElementBeforeShuffle = (element) => {
    if (isShuffleSimilarButton(element)) return false;
    const shuffleButton = findNativeShuffleButton();
    if (!shuffleButton) return false;
    if (element.nextElementSibling !== shuffleButton) {
      shuffleButton.before(element);
    }
    return true;
  };

  // src/ui/nativeShuffleGuard.ts
  var hookedButton = null;
  var shuffleClickBlocker = null;
  var injectStyles = () => {
    if (document.getElementById("shuffle-similar-native-guard-styles")) return;
    const style = document.createElement("style");
    style.id = "shuffle-similar-native-guard-styles";
    style.textContent = `
    ${NATIVE_SHUFFLE_SELECTORS.join(", ")}[data-shuffle-similar-blocked="true"] {
      opacity: 0.28 !important;
      cursor: not-allowed !important;
      pointer-events: none !important;
      filter: grayscale(1);
    }
  `;
    document.head.appendChild(style);
  };
  var enforceNativeShuffleOff = () => {
    if (!sessionManager.isToggleEnabled()) return;
    try {
      if (Spicetify.Player.getShuffle?.()) {
        Spicetify.Player.setShuffle(false);
      }
    } catch {
    }
  };
  var getShuffleClickBlocker = () => {
    if (!shuffleClickBlocker) {
      shuffleClickBlocker = (event) => {
        if (!sessionManager.isToggleEnabled()) return;
        if (!isNativeShuffleTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        enforceNativeShuffleOff();
        Spicetify.showNotification("Turn off Shuffle Similar to use Spotify shuffle", true);
      };
    }
    return shuffleClickBlocker;
  };
  var blockShuffleClicks = (button) => {
    button.addEventListener("click", getShuffleClickBlocker(), true);
  };
  var unblockShuffleClicks = (button) => {
    if (!shuffleClickBlocker) return;
    button.removeEventListener("click", shuffleClickBlocker, true);
  };
  var applyBlockedState = (button, blocked) => {
    if (blocked) {
      button.setAttribute("data-shuffle-similar-blocked", "true");
      button.setAttribute("aria-disabled", "true");
      button.disabled = true;
      button.tabIndex = -1;
      blockShuffleClicks(button);
      return;
    }
    button.removeAttribute("data-shuffle-similar-blocked");
    button.removeAttribute("aria-disabled");
    button.disabled = false;
    button.tabIndex = 0;
    unblockShuffleClicks(button);
  };
  var updateNativeShuffleGuard = () => {
    const blocked = sessionManager.isToggleEnabled();
    enforceNativeShuffleOff();
    const button = findNativeShuffleButton();
    if (!button) return;
    if (hookedButton && hookedButton !== button) {
      applyBlockedState(hookedButton, false);
    }
    hookedButton = button;
    applyBlockedState(button, blocked);
  };
  var registerNativeShuffleGuard = () => {
    injectStyles();
    updateNativeShuffleGuard();
  };

  // src/sources/artistTracks.ts
  var parseYear2 = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const match = value.match(/\d{4}/);
      if (match) return Number(match[0]);
    }
    return void 0;
  };
  var fetchAlbumTracks = async (albumUri) => {
    try {
      const { queryAlbumTracks } = Spicetify.GraphQL.Definitions;
      const { data } = await Spicetify.GraphQL.Request(queryAlbumTracks, {
        uri: albumUri,
        offset: 0,
        limit: 100
      });
      const album = data?.albumUnion;
      const items = (album?.tracksV2 ?? album?.tracks ?? []).items ?? [];
      const releaseYear = parseYear2(album?.date?.isoString ?? album?.date?.year);
      return items.map((item) => {
        const track = item?.track;
        if (!track?.uri) return null;
        return {
          uri: track.uri,
          artistUri: track.artists?.items?.[0]?.uri,
          artistName: track.artists?.items?.[0]?.profile?.name,
          albumUri,
          popularity: track.popularity ?? album?.popularity ?? 50,
          releaseYear
        };
      }).filter((candidate) => Boolean(candidate));
    } catch (error) {
      console.warn("[Shuffle Similar] Failed to fetch album tracks", error);
      return [];
    }
  };
  var fetchArtistDiscographyTracks = async (artistUri) => {
    const artistId = getUriId(artistUri);
    if (!artistId) return [];
    try {
      const market = getMarket();
      const res = await Spicetify.CosmosAsync.get(
        `https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=album,single&limit=50&market=${market}`
      );
      const albums = res?.items ?? [];
      if (albums.length === 0) return [];
      const albumIds = albums.map((item) => item.id).filter(Boolean);
      const candidates = [];
      const chunkSize = 20;
      for (let i = 0; i < albumIds.length; i += chunkSize) {
        const chunk = albumIds.slice(i, i + chunkSize);
        const chunkRes = await Spicetify.CosmosAsync.get(
          `https://api.spotify.com/v1/albums?ids=${chunk.join(",")}&market=${market}`
        );
        const fullAlbums = chunkRes?.albums ?? [];
        for (const album of fullAlbums) {
          if (!album) continue;
          const releaseYear = parseYear2(album.release_date);
          const tracks = album.tracks?.items ?? [];
          for (const track of tracks) {
            if (!track?.uri) continue;
            candidates.push({
              uri: track.uri,
              artistUri: `spotify:artist:${artistId}`,
              artistName: track.artists?.[0]?.name ?? album.artists?.[0]?.name,
              albumUri: album.uri,
              popularity: album.popularity ?? 50,
              releaseYear
            });
          }
        }
      }
      const seen = /* @__PURE__ */ new Set();
      return candidates.filter((c) => {
        if (seen.has(c.uri)) return false;
        seen.add(c.uri);
        return true;
      });
    } catch (error) {
      console.warn("[Shuffle Similar] Failed to fetch artist discography tracks", error);
      return [];
    }
  };

  // src/services/shuffleEngine.ts
  var ensurePools = async (seed, forceRefresh = false) => {
    const settings = getSmartConfig(seed);
    let similar = forceRefresh ? [] : sessionManager.getSimilarPool();
    let profile = forceRefresh ? [] : sessionManager.getProfilePool();
    if (similar.length === 0) {
      similar = await fetchSimilarPool(seed, settings);
    }
    if (profile.length === 0) {
      profile = await fetchProfilePool(seed);
    }
    sessionManager.setPools(similar, profile);
    return { similar, profile, settings };
  };
  var buildPlaylistPlayableBatch = async () => {
    const playlistTracks = sessionManager.getPlaylistTracks();
    if (playlistTracks.length === 0) {
      throw new Error("Playlist has no tracks.");
    }
    const seed = sessionManager.getSeed();
    const settings = getSmartConfig(seed);
    const playedUris = sessionManager.getPlayedUris();
    const queuedUris = sessionManager.getQueuedUris();
    const upcomingQueueUris = getUpcomingQueueUris();
    const excludeUris = [.../* @__PURE__ */ new Set([...playedUris, ...queuedUris, ...upcomingQueueUris])];
    const similarPool = await fetchPlaylistSimilarPool(playlistTracks, settings, 3);
    let batch = buildTrackBatch(
      seed,
      sessionManager.getPosition(),
      excludeUris,
      similarPool,
      playlistTracks,
      settings,
      settings.initialQueueSize
    );
    if (batch.length === 0) {
      batch = buildSinglePoolBatch(
        seed,
        playlistTracks,
        excludeUris,
        settings,
        settings.initialQueueSize
      );
    }
    if (batch.length === 0) {
      throw new Error("No suitable tracks found.");
    }
    const playableQueueUris = await filterPlayableUris(batch.map((track) => track.uri));
    const queueUris = playableQueueUris.length > 0 ? playableQueueUris : batch.map((track) => track.uri);
    return { playableQueueUris: queueUris, settings, similarCount: playlistTracks.length, profileCount: 0 };
  };
  var buildArtistPlayableBatch = async () => {
    const artistTracks = sessionManager.getArtistTracks();
    if (artistTracks.length === 0) {
      throw new Error("Artist has no tracks.");
    }
    const seed = sessionManager.getSeed();
    const settings = getSmartConfig(seed);
    const playedUris = sessionManager.getPlayedUris();
    const queuedUris = sessionManager.getQueuedUris();
    const upcomingQueueUris = getUpcomingQueueUris();
    const excludeUris = [.../* @__PURE__ */ new Set([...playedUris, ...queuedUris, ...upcomingQueueUris])];
    const similarTracks = await fetchSimilarPool(seed, settings);
    let batch = buildTrackBatch(
      seed,
      sessionManager.getPosition(),
      excludeUris,
      similarTracks,
      artistTracks,
      settings,
      settings.initialQueueSize
    );
    if (batch.length === 0) {
      batch = buildSinglePoolBatch(
        seed,
        artistTracks,
        excludeUris,
        settings,
        settings.initialQueueSize
      );
    }
    if (batch.length === 0) {
      throw new Error("No suitable tracks found.");
    }
    const playableQueueUris = await filterPlayableUris(batch.map((track) => track.uri));
    const queueUris = playableQueueUris.length > 0 ? playableQueueUris : batch.map((track) => track.uri);
    return { playableQueueUris: queueUris, settings, similarCount: artistTracks.length, profileCount: 0 };
  };
  var buildPlayableBatch = async (seed, forceRefreshPools) => {
    if (sessionManager.isPlaylistSession()) {
      return await buildPlaylistPlayableBatch();
    }
    if (sessionManager.isArtistSession()) {
      return await buildArtistPlayableBatch();
    }
    const { similar, profile, settings } = await ensurePools(seed, forceRefreshPools);
    if (similar.length === 0 && profile.length === 0) {
      throw new Error("Could not find tracks for Shuffle Similar. Try another song.");
    }
    const excludeUris = [
      .../* @__PURE__ */ new Set([
        ...sessionManager.getPlayedUris(),
        ...sessionManager.getQueuedUris(),
        ...getUpcomingQueueUris()
      ])
    ];
    const batch = buildTrackBatch(
      seed,
      sessionManager.getPosition(),
      excludeUris,
      similar,
      profile,
      settings,
      settings.initialQueueSize
    );
    if (batch.length === 0) {
      throw new Error("No suitable tracks found. Try again.");
    }
    const playableQueueUris = await filterPlayableUris(batch.map((track) => track.uri));
    const queueUris = playableQueueUris.length > 0 ? playableQueueUris : batch.map((track) => track.uri);
    if (queueUris.length === 0) {
      throw new Error("Could not build a shuffle queue. Try another song.");
    }
    return { playableQueueUris: queueUris, settings, similarCount: similar.length, profileCount: profile.length };
  };
  var formatSuccessMessage = (queueSize, position, settings, similarCount) => {
    if (sessionManager.isPlaylistSession()) {
      return `Shuffle Similar: ${queueSize} queued \xB7 playlist blend`;
    }
    if (sessionManager.isArtistSession()) {
      return `Shuffle Similar: ${queueSize} queued \xB7 artist blend`;
    }
    const { similarWeight, profileWeight } = getBlendWeights(position, settings);
    const mode = similarWeight >= profileWeight ? `similar (${similarCount} sources)` : "your library";
    return `Shuffle Similar: ${queueSize} queued \xB7 ${mode}`;
  };
  var startShuffleSimilar = async (seedUri, contextUri, options = {}) => {
    const seed = await fetchSeedMetadata(seedUri);
    if (contextUri && isPlaylistContext(contextUri)) {
      const playlistTracks = await fetchAllPlaylistTracks(contextUri);
      const topTracks = await fetchTopTracks();
      sessionManager.startPlaylistSession(seed, contextUri, playlistTracks, topTracks);
    } else if (contextUri && isAlbumContext(contextUri)) {
      const albumTracks = await fetchAlbumTracks(contextUri);
      sessionManager.startPlaylistSession(seed, contextUri, albumTracks, []);
    } else if (contextUri && isArtistContext(contextUri)) {
      const artistTracks = await fetchArtistDiscographyTracks(contextUri);
      sessionManager.startArtistSession(seed, contextUri, artistTracks);
    } else {
      sessionManager.startSession(seed);
    }
    enableAutoplayGuard();
    enforceNativeShuffleOff();
    const { playableQueueUris, settings, similarCount } = await buildPlayableBatch(
      seed,
      options.forceRefreshPools ?? true
    );
    const currentUri = Spicetify.Player.data?.item?.uri;
    if (options.replaceUpcoming && currentUri) {
      const upcoming = playableQueueUris.filter(
        (uri) => uri !== currentUri && uri !== seed.uri
      );
      sessionManager.setQueuedUris(upcoming);
      syncKnownQueue(upcoming);
      await replaceUpcomingQueue(currentUri, upcoming);
    } else if (options.playSeed) {
      const upcoming = playableQueueUris.filter((uri) => uri !== seed.uri);
      sessionManager.setQueuedUris(upcoming);
      syncKnownQueue(upcoming);
      const playbackContext = resolveShuffleSimilarPlaybackContext(contextUri, seed.albumUri);
      await playSeedAndQueue(seed.uri, upcoming, playbackContext);
    } else {
      const upcoming = playableQueueUris.filter(
        (uri) => uri !== currentUri && uri !== seed.uri
      );
      sessionManager.setQueuedUris(upcoming);
      syncKnownQueue(upcoming);
      await replaceUpcomingQueue(currentUri ?? seed.uri, upcoming);
    }
    await detachFromPlaylistContext(seed.albumUri);
    sessionManager.setToggleEnabled(true);
    Spicetify.showNotification(
      formatSuccessMessage(playableQueueUris.length, sessionManager.getPosition(), settings, similarCount)
    );
  };
  var startFromContextMenu = async (seedUri, contextUri) => {
    await startShuffleSimilar(seedUri, contextUri, {
      forceRefreshPools: true,
      playSeed: true,
      replaceUpcoming: false
    });
  };
  var reshuffleFromCurrentTrack = async () => {
    const uri = Spicetify.Player.data?.item?.uri;
    if (!uri) {
      throw new Error("Play a song first, then enable Shuffle Similar");
    }
    const playerContextUri = Spicetify.Player.data?.context?.uri ?? null;
    await startShuffleSimilar(uri, playerContextUri, {
      forceRefreshPools: true,
      playSeed: false,
      replaceUpcoming: true
    });
  };
  var reshuffleOnToggleOff = async () => {
    const shuffled = await shuffleUpcomingInPlace();
    if (!shuffled) return;
    Spicetify.showNotification("Queue reshuffled");
  };
  var refillQueueIfNeeded = async () => {
    if (!sessionManager.isActive() || sessionManager.isRefilling()) return;
    const seed = sessionManager.getSeed();
    if (!seed) return;
    const settings = getSmartConfig(seed);
    const upcoming = getUpcomingCount();
    if (upcoming >= settings.refillThreshold) return;
    sessionManager.setRefilling(true);
    try {
      const foreign = detectForeignInjection();
      if (foreign.length > 0) {
        const cleaned = getUpcomingQueueUris().filter((uri) => sessionManager.ownsQueueTrack(uri));
        const current = Spicetify.Player.data?.item?.uri;
        await replaceUpcomingQueue(current, cleaned);
      }
      const { playableQueueUris } = await buildPlayableBatch(seed, false);
      const alreadyQueued = new Set(getUpcomingQueueUris());
      const batchUris = playableQueueUris.filter((uri) => !alreadyQueued.has(uri)).slice(0, settings.initialQueueSize);
      if (batchUris.length === 0) return;
      await appendTracksToQueue(batchUris.map((uri) => ({ uri })));
      const merged = [...getUpcomingQueueUris(), ...batchUris];
      sessionManager.setQueuedUris(merged);
      syncKnownQueue(merged);
    } catch (error) {
      console.error("[Shuffle Similar] refill failed", error);
    } finally {
      sessionManager.setRefilling(false);
    }
  };
  var handleSongChange = async () => {
    const uri = Spicetify.Player.data?.item?.uri;
    if (!uri) return;
    if (!sessionManager.isToggleEnabled() || !sessionManager.isActive()) return;
    enforceNativeShuffleOff();
    sessionManager.recordTrackPlayed(uri);
    await refillQueueIfNeeded();
  };

  // src/ui/shuffleSimilarUiState.ts
  var syncHandler = null;
  var registerShuffleSimilarUiSync = (handler) => {
    syncHandler = handler;
  };
  var syncShuffleSimilarFromPlayback = () => {
    syncHandler?.();
  };

  // src/ui/contextMenu.ts
  var contextMenuRegistered = false;
  var runPlayWithShuffleSimilar = (uris) => {
    Spicetify.showNotification("Building Shuffle Similar queue...");
    setTimeout(() => {
      handlePlayWithShuffleSimilar(uris).catch((error) => {
        console.error("[Shuffle Similar]", error);
        Spicetify.showNotification(
          error instanceof Error ? error.message : "Shuffle Similar failed",
          true
        );
      });
    }, 100);
  };
  var getUriType = (uri) => {
    try {
      if (!Spicetify.URI) return null;
      return Spicetify.URI.fromString(uri).type;
    } catch {
      return null;
    }
  };
  var isTrackUri = (uri) => {
    if (uri.startsWith("spotify:track:")) return true;
    const { Type } = Spicetify.URI ?? {};
    if (!Type) return false;
    return getUriType(uri) === Type.TRACK;
  };
  var isArtistUri = (uri) => {
    if (uri.startsWith("spotify:artist:")) return true;
    const { Type } = Spicetify.URI ?? {};
    if (!Type) return false;
    return getUriType(uri) === Type.ARTIST;
  };
  var isAlbumUri = (uri) => {
    if (uri.startsWith("spotify:album:")) return true;
    const { Type } = Spicetify.URI ?? {};
    if (!Type) return false;
    return getUriType(uri) === Type.ALBUM;
  };
  var isPlaylistOnly = (uris) => {
    if (!uris?.length || uris.length > 1) return false;
    return isPlaylistContext(uris[0]);
  };
  var isNonPlaylist = (uris) => {
    if (!uris?.length) return false;
    try {
      if (uris.length > 1) {
        return uris.every(isTrackUri);
      }
      const uri = uris[0];
      return isTrackUri(uri) || isArtistUri(uri) || isAlbumUri(uri);
    } catch {
      return uris.some(
        (uri) => uri.startsWith("spotify:track:") || uri.startsWith("spotify:artist:") || uri.startsWith("spotify:album:")
      );
    }
  };
  var handlePlayWithShuffleSimilar = async (uris) => {
    const seedUri = await pickSeedFromCollection(uris);
    if (!seedUri) {
      Spicetify.showNotification("Nothing to play", true);
      return;
    }
    const rawContext = uris.length === 1 && isValidPlaybackContext(uris[0]) ? uris[0] : null;
    const contextUri = rawContext;
    await startFromContextMenu(seedUri, contextUri);
    syncShuffleSimilarFromPlayback();
  };
  var registerContextMenu = () => {
    if (contextMenuRegistered) return;
    if (!Spicetify.ContextMenu?.Item) {
      throw new Error("Spicetify.ContextMenu.Item is not available");
    }
    new Spicetify.ContextMenu.Item(
      "Shuffle Similar",
      runPlayWithShuffleSimilar,
      isNonPlaylist,
      "enhance"
    ).register();
    new Spicetify.ContextMenu.Item(
      "Shuffle Similar",
      runPlayWithShuffleSimilar,
      isPlaylistOnly,
      "enhance"
    ).register();
    contextMenuRegistered = true;
    console.info("[Shuffle Similar] Context menus registered");
  };

  // src/ui/icons.ts
  var RESHUFFLE_ICON_MARKUP = [
    // Upper-right arrow (clockwise arc with arrowhead)
    `<path d="M13.5 8A5.5 5.5 0 0 0 8 2.5V1l-2.5 2L8 5V3.5A4.5 4.5 0 0 1 12.5 8h1z"/>`,
    // Lower-left arrow (counter-clockwise arc with arrowhead)
    `<path d="M2.5 8A5.5 5.5 0 0 0 8 13.5V15l2.5-2L8 11v1.5A4.5 4.5 0 0 1 3.5 8h-1z"/>`
  ].join("");
  var applySvgIconMarkup = (svg, markup) => {
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "currentColor");
    svg.innerHTML = markup;
  };
  var applyEnhanceIcon = (svg) => {
    const markup = Spicetify.SVGIcons?.enhance ?? Spicetify.SVGIcons?.shuffle ?? "";
    if (!markup) return;
    applySvgIconMarkup(svg, markup);
  };
  var applyRefreshIcon = (svg) => {
    applySvgIconMarkup(svg, RESHUFFLE_ICON_MARKUP);
  };

  // src/utils/debounce.ts
  var debounce = (fn, waitMs) => {
    let timer = null;
    return (...args) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn(...args);
      }, waitMs);
    };
  };

  // src/ui/toggleButton.ts
  var STYLE_ID = "shuffle-similar-button-styles";
  var BUTTON_CLASS = "shuffle-similar-playbar-btn";
  var CLICK_ANIMATION_CLASS = "shuffle-similar-click";
  var TEST_ID = SHUFFLE_SIMILAR_TEST_ID;
  var buttonElement = null;
  var buttonTippy = null;
  var isBusy = false;
  var placementObserver = null;
  var injectStyles2 = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
    button[data-testid="${TEST_ID}"].${BUTTON_CLASS} {
      position: relative;
      display: inline-flex !important;
      align-items: center;
      justify-content: center;
      opacity: 1 !important;
      visibility: visible !important;
      transition: color 0.25s ease;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}[aria-checked="false"] {
      color: rgba(var(--spice-rgb-text), 0.7) !important;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}[aria-checked="false"] svg {
      filter: none !important;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}[aria-checked="true"] {
      color: var(--spice-button) !important;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}[aria-checked="true"] svg {
      filter: drop-shadow(0 0 6px rgba(var(--spice-rgb-selected-row), 0.85));
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}.${CLICK_ANIMATION_CLASS} {
      animation: shuffle-similar-pulse 0.55s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}.${CLICK_ANIMATION_CLASS}::after {
      content: "";
      position: absolute;
      inset: -2px;
      border-radius: 50%;
      border: 2px solid var(--spice-button);
      opacity: 0;
      animation: shuffle-similar-ring 0.65s ease-out forwards;
      pointer-events: none;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}[data-hover-refresh="true"] svg {
      animation: shuffle-similar-spin 0.6s ease-out 1;
    }

    @keyframes shuffle-similar-pulse {
      0% { transform: scale(1); }
      35% { transform: scale(1.18); }
      100% { transform: scale(1); }
    }

    @keyframes shuffle-similar-ring {
      0% {
        opacity: 0.85;
        transform: scale(0.75);
      }
      100% {
        opacity: 0;
        transform: scale(1.75);
      }
    }

    @keyframes shuffle-similar-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
    document.head.appendChild(style);
  };
  var applyButtonIcon = (icon) => {
    const svg = buttonElement?.querySelector("svg");
    if (!svg) return;
    if (icon === "reload") {
      applyRefreshIcon(svg);
      return;
    }
    applyEnhanceIcon(svg);
  };
  var updateTooltip = (label) => {
    buttonElement?.setAttribute("aria-label", label);
    buttonElement?.setAttribute("title", label);
    buttonTippy?.setContent(label);
  };
  var refreshTooltip = () => {
    if (!sessionManager.isToggleEnabled()) {
      updateTooltip("Shuffle Similar");
      return;
    }
    updateTooltip("Turn off Shuffle Similar \xB7 Shift+click to reshuffle");
  };
  var handleMouseEnter = () => {
    if (!buttonElement || !sessionManager.isToggleEnabled()) return;
    buttonElement.setAttribute("data-hover-refresh", "true");
    applyButtonIcon("reload");
  };
  var handleMouseLeave = () => {
    if (!buttonElement) return;
    buttonElement.removeAttribute("data-hover-refresh");
    applyButtonIcon("default");
  };
  var playClickAnimation = () => {
    if (!buttonElement) return;
    buttonElement.classList.remove(CLICK_ANIMATION_CLASS);
    void buttonElement.offsetWidth;
    buttonElement.classList.add(CLICK_ANIMATION_CLASS);
    const handleAnimationEnd = () => {
      buttonElement?.classList.remove(CLICK_ANIMATION_CLASS);
      buttonElement?.removeEventListener("animationend", handleAnimationEnd);
    };
    buttonElement.addEventListener("animationend", handleAnimationEnd);
  };
  var stripActivePresentation = (button) => {
    for (const className of Array.from(button.classList)) {
      if (className.toLowerCase().includes("active")) {
        button.classList.remove(className);
      }
    }
    button.removeAttribute("data-active");
    const svg = button.querySelector("svg");
    svg?.style.removeProperty("filter");
    svg?.style.removeProperty("color");
  };
  var setButtonActive = (active) => {
    if (!buttonElement) return;
    buttonElement.setAttribute("aria-checked", active ? "true" : "false");
    buttonElement.classList.toggle("active", active);
    if (!active) {
      stripActivePresentation(buttonElement);
    }
  };
  var placeButton = () => {
    if (!buttonElement) return false;
    return placeElementBeforeShuffle(buttonElement);
  };
  var createShuffleSimilarButton = (shuffleReference) => {
    const button = shuffleReference.cloneNode(true);
    button.setAttribute("data-testid", TEST_ID);
    button.setAttribute("aria-label", "Shuffle Similar");
    button.setAttribute("aria-checked", "false");
    button.classList.add(BUTTON_CLASS);
    button.removeAttribute("disabled");
    button.removeAttribute("data-shuffle-similar-blocked");
    button.removeAttribute("aria-disabled");
    button.tabIndex = 0;
    stripActivePresentation(button);
    const svg = button.querySelector("svg");
    if (svg) {
      applyEnhanceIcon(svg);
    }
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handleButtonClick(event);
    });
    button.addEventListener("mouseenter", handleMouseEnter);
    button.addEventListener("mouseleave", handleMouseLeave);
    return button;
  };
  var mountButton = () => {
    removeLegacyExtensionButtons();
    if (buttonElement && document.contains(buttonElement)) {
      syncButtonFromSession();
      return placeButton();
    }
    const shuffleButton = findNativeShuffleButton();
    if (!shuffleButton) return false;
    injectStyles2();
    if (buttonElement && !document.contains(buttonElement)) {
      buttonElement = null;
    }
    buttonElement = createShuffleSimilarButton(shuffleButton);
    shuffleButton.before(buttonElement);
    if (Spicetify.Tippy && Spicetify.TippyProps) {
      buttonTippy = Spicetify.Tippy(buttonElement, {
        ...Spicetify.TippyProps,
        content: "Shuffle Similar"
      });
    }
    syncButtonFromSession();
    console.info("[Shuffle Similar] Playbar button mounted left of shuffle");
    return true;
  };
  var ensureButtonInDom = () => {
    if (!buttonElement || !document.contains(buttonElement)) {
      buttonElement = null;
      mountButton();
      return;
    }
    placeButton();
    syncButtonFromSession();
  };
  var schedulePlacementWatch = () => {
    if (placementObserver) return;
    const shuffleButton = findNativeShuffleButton();
    const parent = shuffleButton?.parentElement;
    if (!parent) return;
    const syncPlacement = debounce(() => {
      ensureButtonInDom();
      if (sessionManager.isToggleEnabled()) {
        updateNativeShuffleGuard();
      }
    }, 750);
    placementObserver = new MutationObserver(syncPlacement);
    placementObserver.observe(parent, { childList: true });
  };
  var syncButtonFromSession = () => {
    const enabled = sessionManager.isToggleEnabled();
    setButtonActive(enabled);
    if (!enabled) {
      buttonElement?.removeAttribute("data-hover-refresh");
      applyButtonIcon("default");
    }
    refreshTooltip();
  };
  var handleButtonClick = (event) => {
    if (!buttonElement || isBusy) return;
    if (!sessionManager.isToggleEnabled()) {
      void enableShuffleSimilar();
      return;
    }
    if (event.shiftKey) {
      void reshuffleActiveSession();
      return;
    }
    void disableShuffleSimilar();
  };
  var waitForShuffleButton = () => {
    const attemptMount = () => {
      if (!mountButton()) return false;
      schedulePlacementWatch();
      return true;
    };
    if (attemptMount()) return;
    let attempts = 0;
    const interval = setInterval(() => {
      attempts += 1;
      if (attemptMount() || attempts >= 60) {
        clearInterval(interval);
        if (attempts >= 60) {
          console.warn("[Shuffle Similar] Could not find shuffle button to mount playbar control");
        }
      }
    }, 2e3);
  };
  var enableShuffleSimilar = async () => {
    if (isBusy) return;
    isBusy = true;
    playClickAnimation();
    try {
      sessionManager.setToggleEnabled(true);
      enforceNativeShuffleOff();
      enableAutoplayGuard();
      updateNativeShuffleGuard();
      setButtonActive(true);
      refreshTooltip();
      Spicetify.showNotification("Building Shuffle Similar queue...");
      await reshuffleFromCurrentTrack();
    } catch (error) {
      console.error("[Shuffle Similar]", error);
      setButtonActive(false);
      sessionManager.setToggleEnabled(false);
      disableAutoplayGuard();
      sessionManager.endSession();
      updateNativeShuffleGuard();
      refreshTooltip();
      Spicetify.showNotification(
        error instanceof Error ? error.message : "Shuffle Similar failed",
        true
      );
    } finally {
      isBusy = false;
    }
  };
  var reshuffleActiveSession = async () => {
    if (isBusy) return;
    isBusy = true;
    playClickAnimation();
    try {
      Spicetify.showNotification("Reshuffling queue...");
      await reshuffleFromCurrentTrack();
      refreshTooltip();
    } catch (error) {
      console.error("[Shuffle Similar]", error);
      Spicetify.showNotification(
        error instanceof Error ? error.message : "Reshuffle failed",
        true
      );
    } finally {
      isBusy = false;
    }
  };
  var disableShuffleSimilar = async () => {
    if (isBusy) return;
    isBusy = true;
    playClickAnimation();
    try {
      sessionManager.setToggleEnabled(false);
      disableAutoplayGuard();
      sessionManager.endSession();
      setButtonActive(false);
      buttonElement?.removeAttribute("data-hover-refresh");
      applyButtonIcon("default");
      updateNativeShuffleGuard();
      refreshTooltip();
      await reshuffleOnToggleOff();
      Spicetify.showNotification("Shuffle Similar disabled");
    } catch (error) {
      console.error("[Shuffle Similar]", error);
      sessionManager.setToggleEnabled(false);
      disableAutoplayGuard();
      sessionManager.endSession();
      setButtonActive(false);
      updateNativeShuffleGuard();
      refreshTooltip();
      Spicetify.showNotification(
        error instanceof Error ? error.message : "Shuffle Similar failed",
        true
      );
    } finally {
      isBusy = false;
    }
  };
  var syncUiFromPlayback = () => {
    sessionManager.setToggleEnabled(true);
    enforceNativeShuffleOff();
    enableAutoplayGuard();
    updateNativeShuffleGuard();
    ensureButtonInDom();
    syncButtonFromSession();
  };
  var registerToggleButton = () => {
    removeLegacyExtensionButtons();
    watchForLegacyExtensionButtons();
    registerShuffleSimilarUiSync(syncUiFromPlayback);
    waitForShuffleButton();
  };

  // src/app.tsx
  var GLOBAL_LOAD_KEY = "__shuffleSimilarExtensionLoaded__";
  var globalScope = globalThis;
  if (globalScope[GLOBAL_LOAD_KEY]) {
    console.warn(
      "[Shuffle Similar] Extension already loaded \u2014 remove duplicate entries from spicetify config extensions and delete old better-shuffle.js / similar-shuffle.js files"
    );
  } else {
    globalScope[GLOBAL_LOAD_KEY] = true;
    bootExtension();
  }
  function bootExtension() {
    removeLegacyExtensionButtons();
    const PLAYBAR_INIT_DELAY_MS = 4e3;
    let initialized = false;
    let playbarInitialized = false;
    const initializePlaybarFeatures = () => {
      if (playbarInitialized) return;
      playbarInitialized = true;
      try {
        registerNativeShuffleGuard();
      } catch (error) {
        console.error("[Shuffle Similar] Native shuffle guard failed", error);
      }
      try {
        registerToggleButton();
      } catch (error) {
        console.error("[Shuffle Similar] Playbar button registration failed", error);
      }
    };
    const tryRegisterContextMenu = () => {
      try {
        registerContextMenu();
      } catch (error) {
        console.error("[Shuffle Similar] Context menu registration failed", error);
      }
    };
    const initializeExtension = () => {
      if (initialized) return;
      initialized = true;
      tryRegisterContextMenu();
      setTimeout(tryRegisterContextMenu, 2e3);
      Spicetify.Player.addEventListener("songchange", () => {
        if (sessionManager.isToggleEnabled()) {
          enforceNativeShuffleOff();
        }
        updateNativeShuffleGuard();
        void handleSongChange();
      });
      setTimeout(initializePlaybarFeatures, PLAYBAR_INIT_DELAY_MS);
      console.info("[Shuffle Similar] Extension initialized");
    };
    const isSpicetifyReady = () => Boolean(
      Spicetify.Platform && Spicetify.Player && Spicetify.URI && Spicetify.ContextMenu?.Item && Spicetify.Menu?.Item && Spicetify.PopupModal
    );
    const waitForSpicetify = () => {
      if (isSpicetifyReady()) {
        initializeExtension();
        return;
      }
      setTimeout(waitForSpicetify, 200);
    };
    const spicetifyEvents = Spicetify.Events;
    spicetifyEvents?.platformLoaded?.addListener?.(waitForSpicetify);
    spicetifyEvents?.webpackLoaded?.addListener?.(() => {
      tryRegisterContextMenu();
    });
    waitForSpicetify();
  }
})();
