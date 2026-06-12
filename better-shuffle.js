// NAME: Better Shuffle
// DESCRIPTION: Progressive shuffle — similar genre/era first, then your library
// VERSION: 1.0.0
// AUTHORS: Better Shuffle Contributors

"use strict";
(() => {
  // src/storage/settings.ts
  var STORAGE_KEY = "betterShuffle:settings";
  var HISTORY_KEY = "betterShuffle:playHistory";
  var DEFAULT_BLEND_PHASES = [
    { maxPosition: 4, similarWeight: 1, profileWeight: 0 },
    { maxPosition: 9, similarWeight: 0.7, profileWeight: 0.3 },
    { maxPosition: 19, similarWeight: 0.4, profileWeight: 0.6 },
    { maxPosition: Number.POSITIVE_INFINITY, similarWeight: 0.2, profileWeight: 0.8 }
  ];
  var DEFAULT_SETTINGS = {
    eraWindow: 3,
    artistSpacing: 3,
    refillThreshold: 3,
    initialQueueSize: 25,
    excludeSeedArtistEarly: true,
    historyPenaltyWindow: 200,
    deprioritizePopular: true,
    matchTempo: true,
    matchEnergy: true,
    matchValence: true,
    blendPhases: DEFAULT_BLEND_PHASES
  };
  var loadSettings = () => {
    try {
      const raw = Spicetify.LocalStorage.get(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS, blendPhases: [...DEFAULT_BLEND_PHASES] };
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        blendPhases: parsed.blendPhases ?? [...DEFAULT_BLEND_PHASES]
      };
    } catch {
      return { ...DEFAULT_SETTINGS, blendPhases: [...DEFAULT_BLEND_PHASES] };
    }
  };
  var saveSettings = (settings) => {
    Spicetify.LocalStorage.set(STORAGE_KEY, JSON.stringify(settings));
  };
  var loadPlayHistory = () => {
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
  var getBlendWeights = (position, phases) => {
    const phase = phases.find((entry) => position <= entry.maxPosition) ?? phases[phases.length - 1];
    return {
      similarWeight: phase.similarWeight,
      profileWeight: phase.profileWeight
    };
  };
  var buildTrackBatch = (seed, position, sessionPlayedUris, similarPool, profilePool, settings, count) => {
    const { similarWeight, profileWeight } = getBlendWeights(position, settings.blendPhases);
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
    isRefilling: false
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
    startSession: (seed) => {
      state.active = true;
      state.seed = seed;
      state.playedUris = [seed.uri];
      state.queuedUris = [];
      state.position = 0;
      state.similarPool = [];
      state.profilePool = [];
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
    },
    recordTrackPlayed: (uri) => {
      if (!uri || uri === "spotify:delimiter") return;
      if (!state.playedUris.includes(uri)) {
        state.playedUris.push(uri);
      }
      state.position += 1;
      state.queuedUris = state.queuedUris.filter((queuedUri) => queuedUri !== uri);
      const settings = loadSettings();
      appendPlayHistory(uri, settings.historyPenaltyWindow);
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
        console.warn("[Better Shuffle] playability check failed, keeping chunk", error);
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
      return enrichSeedMetadata({
        uri,
        trackId: base.trackId,
        trackName: track?.name ?? base.trackName,
        artistName: artist?.name ?? base.artistName,
        artistUri: artist?.uri ?? base.artistUri,
        albumUri: track?.album?.uri ?? base.albumUri,
        releaseYear: parseYear(track?.album?.release_date) ?? base.releaseYear,
        genres
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
      return {
        ...seed,
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
      console.warn("[Better Shuffle] Web API liked songs failed, trying collection API", webApiError);
    }
    try {
      return await fetchLikedTracksFromCollection();
    } catch (collectionError) {
      console.warn("[Better Shuffle] Collection API liked songs failed", collectionError);
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
    return (res.items ?? []).filter((item) => item.isPlayable).map(
      (item) => candidateFromUri(item.uri, item.metadata)
    );
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
    if (uris.length === 1) return uris[0];
    const uriObj = Spicetify.URI.fromString(uris[0]);
    const { Type: Type2 } = Spicetify.URI;
    switch (uriObj.type) {
      case Type2.PLAYLIST:
      case Type2.PLAYLIST_V2: {
        const tracks = await fetchPlaylistTracks(uris[0]);
        return pickRandom(tracks)?.uri ?? uris[0];
      }
      case Type2.ALBUM: {
        const { queryAlbumTracks } = Spicetify.GraphQL.Definitions;
        const { data } = await Spicetify.GraphQL.Request(queryAlbumTracks, {
          uri: uris[0],
          offset: 0,
          limit: 100
        });
        const items = (data?.albumUnion?.tracksV2 ?? data?.albumUnion?.tracks ?? []).items ?? [];
        const playable = items.map((item) => item.track).filter(
          (track) => Boolean(track?.playability?.playable && track.uri)
        );
        return pickRandom(playable)?.uri ?? uris[0];
      }
      case Type2.ARTIST: {
        const { queryArtistOverview } = Spicetify.GraphQL.Definitions;
        const { data } = await Spicetify.GraphQL.Request(queryArtistOverview, {
          uri: uris[0],
          locale: Spicetify.Locale.getLocale(),
          includePrerelease: false
        });
        const topTracks = data?.artistUnion?.discography?.topTracks?.items ?? [];
        const playable = topTracks.map((item) => item.track).filter((track) => Boolean(track?.uri));
        return pickRandom(playable)?.uri ?? uris[0];
      }
      default:
        return uris[0];
    }
  };

  // src/sources/similarTracks.ts
  var fetchPlaylistCandidates = async (playlistUri) => {
    try {
      const playlistId = getUriId(playlistUri);
      const res = await Spicetify.Platform.PlaylistAPI.getContents(`spotify:playlist:${playlistId}`, {
        limit: 100
      });
      return (res.items ?? []).filter((item) => item.isPlayable).map(
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
      console.warn("[Better Shuffle] Failed to fetch audio features", error);
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
      console.warn("[Better Shuffle] v1/recommendations failed", error);
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
    return candidates.filter((candidate) => candidate.uri !== seed.uri);
  };

  // src/queue/queueManager.ts
  var { Type } = Spicetify.URI;
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
      const type = Spicetify.URI.fromString(uri).type;
      return type === Type.PLAYLIST || type === Type.PLAYLIST_V2;
    } catch {
      return false;
    }
  };
  var isValidPlaybackContext = (uri) => {
    if (!uri) return false;
    try {
      const type = Spicetify.URI.fromString(uri).type;
      return type === Type.PLAYLIST || type === Type.PLAYLIST_V2 || type === Type.ALBUM || type === Type.ARTIST;
    } catch {
      return false;
    }
  };
  var resolveBetterShufflePlaybackContext = (contextUri, albumUri) => {
    if (contextUri && !isPlaylistContext(contextUri) && isValidPlaybackContext(contextUri)) {
      return { uri: contextUri, url: `context://${contextUri}` };
    }
    if (albumUri) {
      try {
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
    if (!isPlaylistContext(currentContextUri)) return;
    const fallback = resolveBetterShufflePlaybackContext(null, albumUri);
    if (!fallback) return;
    try {
      const sessionId = Spicetify.Platform.PlayerAPI.getState().sessionId;
      await Spicetify.Platform.PlayerAPI.updateContext(sessionId, {
        uri: fallback.uri,
        url: fallback.url
      });
    } catch (error) {
      console.warn("[Better Shuffle] Could not switch away from playlist context", error);
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
      console.warn("[Better Shuffle] setQueue failed", error);
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
  var BETTER_SHUFFLE_TEST_ID = "better-shuffle-button";
  var NATIVE_SHUFFLE_SELECTORS = [
    `button[data-testid="control-button-shuffle"]:not([data-testid="${BETTER_SHUFFLE_TEST_ID}"])`,
    `.main-shuffleButton-button:not([data-testid="${BETTER_SHUFFLE_TEST_ID}"])`
  ];
  var isBetterShuffleButton = (element) => element instanceof HTMLButtonElement && element.getAttribute("data-testid") === BETTER_SHUFFLE_TEST_ID;
  var isNativeShuffleLabel = (label) => {
    const normalized = label.toLowerCase();
    if (!normalized.includes("shuffle")) return false;
    if (normalized.includes("smart")) return false;
    if (normalized.includes("better")) return false;
    return true;
  };
  var findNativeShuffleButton = () => {
    for (const selector of NATIVE_SHUFFLE_SELECTORS) {
      const element = document.querySelector(selector);
      if (element instanceof HTMLButtonElement && !isBetterShuffleButton(element)) {
        return element;
      }
    }
    const playPause = document.querySelector('button[data-testid="control-button-playpause"]');
    const controlGroup = playPause?.parentElement;
    if (controlGroup) {
      const byTestId = controlGroup.querySelector('button[data-testid="control-button-shuffle"]');
      if (byTestId instanceof HTMLButtonElement && !isBetterShuffleButton(byTestId)) {
        return byTestId;
      }
    }
    const playbar = document.querySelector('[data-testid="now-playing-bar"]') ?? document.querySelector(".main-nowPlayingBar-nowPlayingBar");
    if (playbar) {
      const buttons = playbar.querySelectorAll("button");
      for (let index = 0; index < buttons.length; index += 1) {
        const button = buttons.item(index);
        if (!(button instanceof HTMLButtonElement)) continue;
        if (isBetterShuffleButton(button)) continue;
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
    if (isBetterShuffleButton(target) || target.closest(`[data-testid="${BETTER_SHUFFLE_TEST_ID}"]`)) {
      return false;
    }
    const shuffle = findNativeShuffleButton();
    if (shuffle && (target === shuffle || shuffle.contains(target))) return true;
    return Boolean(target.closest(NATIVE_SHUFFLE_SELECTORS.join(", ")));
  };
  var placeElementBeforeShuffle = (element) => {
    if (isBetterShuffleButton(element)) return false;
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
    if (document.getElementById("better-shuffle-native-guard-styles")) return;
    const style = document.createElement("style");
    style.id = "better-shuffle-native-guard-styles";
    style.textContent = `
    ${NATIVE_SHUFFLE_SELECTORS.join(", ")}[data-better-shuffle-blocked="true"] {
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
        Spicetify.showNotification("Turn off Better Shuffle to use Spotify shuffle", true);
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
      button.setAttribute("data-better-shuffle-blocked", "true");
      button.setAttribute("aria-disabled", "true");
      button.disabled = true;
      button.tabIndex = -1;
      blockShuffleClicks(button);
      return;
    }
    button.removeAttribute("data-better-shuffle-blocked");
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

  // src/services/shuffleEngine.ts
  var ensurePools = async (seed, forceRefresh = false) => {
    const settings = loadSettings();
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
  var buildPlayableBatch = async (seed, forceRefreshPools) => {
    const { similar, profile, settings } = await ensurePools(seed, forceRefreshPools);
    if (similar.length === 0 && profile.length === 0) {
      throw new Error("Could not find tracks for Better Shuffle. Try another song.");
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
      throw new Error("No suitable tracks found. Try again or adjust settings.");
    }
    const playableQueueUris = await filterPlayableUris(batch.map((track) => track.uri));
    const queueUris = playableQueueUris.length > 0 ? playableQueueUris : batch.map((track) => track.uri);
    if (queueUris.length === 0) {
      throw new Error("Could not build a shuffle queue. Try another song.");
    }
    return { playableQueueUris: queueUris, settings, similarCount: similar.length, profileCount: profile.length };
  };
  var formatSuccessMessage = (queueSize, position, settings, similarCount) => {
    const { similarWeight, profileWeight } = getBlendWeights(position, settings.blendPhases);
    const mode = similarWeight >= profileWeight ? `similar (${similarCount} sources)` : "your library";
    return `Better Shuffle: ${queueSize} queued \xB7 ${mode}`;
  };
  var startBetterShuffle = async (seedUri, contextUri, options = {}) => {
    const seed = await fetchSeedMetadata(seedUri);
    sessionManager.startSession(seed);
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
      const playbackContext = resolveBetterShufflePlaybackContext(contextUri, seed.albumUri);
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
    await startBetterShuffle(seedUri, contextUri, {
      forceRefreshPools: true,
      playSeed: true,
      replaceUpcoming: false
    });
  };
  var reshuffleFromCurrentTrack = async () => {
    const uri = Spicetify.Player.data?.item?.uri;
    if (!uri) {
      throw new Error("Play a song first, then enable Better Shuffle");
    }
    const playerContextUri = Spicetify.Player.data?.context?.uri ?? null;
    await startBetterShuffle(uri, playerContextUri, {
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
    const settings = loadSettings();
    const upcoming = getUpcomingCount();
    if (upcoming >= settings.refillThreshold) return;
    const seed = sessionManager.getSeed();
    if (!seed) return;
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
      console.error("[Better Shuffle] refill failed", error);
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

  // src/ui/betterShuffleUiState.ts
  var syncHandler = null;
  var registerBetterShuffleUiSync = (handler) => {
    syncHandler = handler;
  };
  var syncBetterShuffleFromPlayback = () => {
    syncHandler?.();
  };

  // src/ui/contextMenu.ts
  var contextMenuRegistered = false;
  var runPlayWithBetterShuffle = (uris) => {
    Spicetify.showNotification("Building Better Shuffle queue...");
    setTimeout(() => {
      handlePlayWithBetterShuffle(uris).catch((error) => {
        console.error("[Better Shuffle]", error);
        Spicetify.showNotification(
          error instanceof Error ? error.message : "Better Shuffle failed",
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
    const { Type: Type2 } = Spicetify.URI ?? {};
    if (!Type2) return false;
    return getUriType(uri) === Type2.TRACK;
  };
  var isArtistUri = (uri) => {
    if (uri.startsWith("spotify:artist:")) return true;
    const { Type: Type2 } = Spicetify.URI ?? {};
    if (!Type2) return false;
    return getUriType(uri) === Type2.ARTIST;
  };
  var shouldShowMenu = (uris) => {
    if (!uris?.length) return false;
    try {
      if (uris.length > 1) {
        return uris.every(isTrackUri);
      }
      const uri = uris[0];
      if (isTrackUri(uri) || isArtistUri(uri)) return true;
      return false;
    } catch {
      return uris.some((uri) => uri.startsWith("spotify:track:") || uri.startsWith("spotify:artist:"));
    }
  };
  var handlePlayWithBetterShuffle = async (uris) => {
    const seedUri = await pickSeedFromCollection(uris);
    if (!seedUri) {
      Spicetify.showNotification("Nothing to play", true);
      return;
    }
    const rawContext = uris.length === 1 && isValidPlaybackContext(uris[0]) ? uris[0] : null;
    const contextUri = rawContext && !isPlaylistContext(rawContext) ? rawContext : null;
    await startFromContextMenu(seedUri, contextUri);
    syncBetterShuffleFromPlayback();
  };
  var registerContextMenu = () => {
    if (contextMenuRegistered) return;
    if (!Spicetify.ContextMenu?.Item) {
      throw new Error("Spicetify.ContextMenu.Item is not available");
    }
    new Spicetify.ContextMenu.Item(
      "Play with Better Shuffle",
      runPlayWithBetterShuffle,
      shouldShowMenu,
      "enhance"
    ).register();
    contextMenuRegistered = true;
    console.info("[Better Shuffle] Context menu registered");
  };

  // src/ui/settingsPage.tsx
  var SETTINGS_STYLE_ID = "better-shuffle-settings-styles";
  var settingsStyles = `
.better-shuffle-settings-root .popup-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
}
.better-shuffle-settings-root .popup-row label {
  color: var(--spice-text);
  flex: 1;
}
.better-shuffle-settings-root .popup-row input[type="number"] {
  width: 72px;
  color: var(--spice-text);
  background: rgba(var(--spice-rgb-shadow), 0.7);
  border: 0;
  border-radius: 4px;
  padding: 6px 8px;
}
.better-shuffle-settings-root .popup-row input[type="checkbox"] {
  width: 18px;
  height: 18px;
}
.better-shuffle-settings-root .popup-title {
  color: var(--spice-text);
  margin: 0 0 8px;
}
.better-shuffle-settings-root .popup-help {
  color: rgba(var(--spice-rgb-text), 0.7);
  font-size: 12px;
  margin: 0 0 16px;
}
.better-shuffle-settings-root .popup-reset {
  margin-top: 12px;
  color: var(--spice-text);
  background: rgba(var(--spice-rgb-shadow), 0.7);
  border: 0;
  border-radius: 999px;
  padding: 8px 14px;
  cursor: pointer;
}
`;
  var injectSettingsStyles = () => {
    if (document.getElementById(SETTINGS_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = SETTINGS_STYLE_ID;
    style.textContent = settingsStyles;
    document.head.appendChild(style);
  };
  var fieldId = (label) => `better-shuffle-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  var createNumberField = (label, value, min, max, onChange) => {
    const row = document.createElement("div");
    row.className = "popup-row";
    const id = fieldId(label);
    const labelEl = document.createElement("label");
    labelEl.htmlFor = id;
    labelEl.textContent = label;
    const input = document.createElement("input");
    input.id = id;
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.setAttribute("aria-label", label);
    input.addEventListener("change", () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed)) return;
      onChange(Math.min(max, Math.max(min, parsed)));
    });
    row.append(labelEl, input);
    return { row, input };
  };
  var createCheckboxField = (label, checked, onChange) => {
    const row = document.createElement("div");
    row.className = "popup-row";
    const id = fieldId(label);
    const labelEl = document.createElement("label");
    labelEl.htmlFor = id;
    labelEl.textContent = label;
    const input = document.createElement("input");
    input.id = id;
    input.type = "checkbox";
    input.checked = checked;
    input.setAttribute("aria-label", label);
    input.addEventListener("change", () => onChange(input.checked));
    row.append(labelEl, input);
    return { row, input };
  };
  var buildSettingsDom = () => {
    injectSettingsStyles();
    let settings = loadSettings();
    const root = document.createElement("div");
    root.className = "better-shuffle-settings-root";
    const title = document.createElement("h3");
    title.className = "popup-title";
    title.textContent = "Better Shuffle Settings";
    const help = document.createElement("p");
    help.className = "popup-help";
    help.textContent = "Starts with genre/era-similar tracks, then gradually blends in your library and playlists.";
    const inputs = {};
    const applyToInputs = (next) => {
      settings = next;
      inputs.eraWindow.value = String(next.eraWindow);
      inputs.artistSpacing.value = String(next.artistSpacing);
      inputs.refillThreshold.value = String(next.refillThreshold);
      inputs.initialQueueSize.value = String(next.initialQueueSize);
      inputs.historyPenaltyWindow.value = String(next.historyPenaltyWindow);
      inputs.deprioritizePopular.checked = next.deprioritizePopular;
      inputs.excludeSeedArtistEarly.checked = next.excludeSeedArtistEarly;
      inputs.matchTempo.checked = next.matchTempo;
      inputs.matchEnergy.checked = next.matchEnergy;
      inputs.matchValence.checked = next.matchValence;
    };
    const persist = (patch) => {
      const next = { ...settings, ...patch };
      saveSettings(next);
      applyToInputs(next);
    };
    const eraField = createNumberField(
      "Era window (\xB1 years)",
      settings.eraWindow,
      1,
      10,
      (eraWindow) => persist({ eraWindow })
    );
    inputs.eraWindow = eraField.input;
    const artistField = createNumberField(
      "Artist spacing",
      settings.artistSpacing,
      1,
      8,
      (artistSpacing) => persist({ artistSpacing })
    );
    inputs.artistSpacing = artistField.input;
    const refillField = createNumberField(
      "Refill when queue has \u2264",
      settings.refillThreshold,
      1,
      10,
      (refillThreshold) => persist({ refillThreshold })
    );
    inputs.refillThreshold = refillField.input;
    const batchField = createNumberField(
      "Tracks per batch",
      settings.initialQueueSize,
      10,
      50,
      (initialQueueSize) => persist({ initialQueueSize })
    );
    inputs.initialQueueSize = batchField.input;
    const historyField = createNumberField(
      "History penalty window",
      settings.historyPenaltyWindow,
      50,
      500,
      (historyPenaltyWindow) => persist({ historyPenaltyWindow })
    );
    inputs.historyPenaltyWindow = historyField.input;
    const popularField = createCheckboxField(
      "Prefer less-played library tracks",
      settings.deprioritizePopular,
      (deprioritizePopular) => persist({ deprioritizePopular })
    );
    inputs.deprioritizePopular = popularField.input;
    const excludeField = createCheckboxField(
      "Exclude seed artist early",
      settings.excludeSeedArtistEarly,
      (excludeSeedArtistEarly) => persist({ excludeSeedArtistEarly })
    );
    inputs.excludeSeedArtistEarly = excludeField.input;
    const tempoField = createCheckboxField(
      "Match seed tempo (BPM)",
      settings.matchTempo,
      (matchTempo) => persist({ matchTempo })
    );
    inputs.matchTempo = tempoField.input;
    const energyField = createCheckboxField(
      "Match seed energy",
      settings.matchEnergy,
      (matchEnergy) => persist({ matchEnergy })
    );
    inputs.matchEnergy = energyField.input;
    const valenceField = createCheckboxField(
      "Match seed mood (valence)",
      settings.matchValence,
      (matchValence) => persist({ matchValence })
    );
    inputs.matchValence = valenceField.input;
    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "popup-reset";
    resetButton.textContent = "Reset defaults";
    resetButton.addEventListener("click", () => {
      persist({
        ...DEFAULT_SETTINGS,
        blendPhases: [...DEFAULT_SETTINGS.blendPhases]
      });
    });
    root.append(
      title,
      help,
      eraField.row,
      artistField.row,
      refillField.row,
      batchField.row,
      historyField.row,
      popularField.row,
      excludeField.row,
      tempoField.row,
      energyField.row,
      valenceField.row,
      resetButton
    );
    return root;
  };
  var openSettingsPage = () => {
    try {
      Spicetify.PopupModal.hide();
    } catch {
    }
    setTimeout(() => {
      Spicetify.PopupModal.display({
        title: "Better Shuffle",
        content: buildSettingsDom(),
        isLarge: true
      });
    }, 100);
  };
  var settingsMenuRegistered = false;
  var registerSettingsMenu = () => {
    if (settingsMenuRegistered) return;
    if (!Spicetify.Menu?.Item || !Spicetify.Menu?.SubMenu) {
      throw new Error("Spicetify.Menu is not available");
    }
    const settingsItem = new Spicetify.Menu.Item(
      "Settings",
      false,
      () => openSettingsPage(),
      "edit"
    );
    new Spicetify.Menu.SubMenu("Better Shuffle", [settingsItem]).register();
    settingsMenuRegistered = true;
    console.info("[Better Shuffle] Profile menu registered");
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
  var STYLE_ID = "better-shuffle-button-styles";
  var BUTTON_CLASS = "better-shuffle-playbar-btn";
  var CLICK_ANIMATION_CLASS = "better-shuffle-click";
  var TEST_ID = BETTER_SHUFFLE_TEST_ID;
  var buttonElement = null;
  var buttonTippy = null;
  var isBusy = false;
  var pendingReshuffleClick = false;
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

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}[aria-checked="true"] {
      color: var(--spice-button) !important;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}[aria-checked="true"] svg {
      filter: drop-shadow(0 0 6px rgba(var(--spice-rgb-selected-row), 0.85));
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}.${CLICK_ANIMATION_CLASS} {
      animation: better-shuffle-pulse 0.55s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}.${CLICK_ANIMATION_CLASS}::after {
      content: "";
      position: absolute;
      inset: -2px;
      border-radius: 50%;
      border: 2px solid var(--spice-button);
      opacity: 0;
      animation: better-shuffle-ring 0.65s ease-out forwards;
      pointer-events: none;
    }

    button[data-testid="${TEST_ID}"].${BUTTON_CLASS}[data-hover-refresh="true"] svg {
      animation: better-shuffle-spin 0.6s ease-out 1;
    }

    @keyframes better-shuffle-pulse {
      0% { transform: scale(1); }
      35% { transform: scale(1.18); }
      100% { transform: scale(1); }
    }

    @keyframes better-shuffle-ring {
      0% {
        opacity: 0.85;
        transform: scale(0.75);
      }
      100% {
        opacity: 0;
        transform: scale(1.75);
      }
    }

    @keyframes better-shuffle-spin {
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
      updateTooltip("Better Shuffle");
      return;
    }
    if (pendingReshuffleClick) {
      updateTooltip("Reshuffle queue");
      return;
    }
    updateTooltip("Turn off Better Shuffle");
  };
  var handleMouseEnter = () => {
    if (!buttonElement || !sessionManager.isToggleEnabled() || !pendingReshuffleClick) return;
    buttonElement.setAttribute("data-hover-refresh", "true");
    applyButtonIcon("reload");
  };
  var handleMouseLeave = () => {
    if (!buttonElement || !sessionManager.isToggleEnabled()) return;
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
  var setButtonActive = (active) => {
    if (!buttonElement) return;
    buttonElement.setAttribute("aria-checked", active ? "true" : "false");
    buttonElement.classList.toggle("active", active);
  };
  var placeButton = () => {
    if (!buttonElement) return false;
    return placeElementBeforeShuffle(buttonElement);
  };
  var createBetterShuffleButton = (shuffleReference) => {
    const button = shuffleReference.cloneNode(true);
    button.setAttribute("data-testid", TEST_ID);
    button.setAttribute("aria-label", "Better Shuffle");
    button.setAttribute("aria-checked", "false");
    button.classList.add(BUTTON_CLASS);
    button.removeAttribute("disabled");
    button.removeAttribute("data-better-shuffle-blocked");
    button.removeAttribute("aria-disabled");
    button.tabIndex = 0;
    const activeClasses = Array.from(button.classList).filter(
      (c) => c.toLowerCase().includes("active")
    );
    for (const c of activeClasses) {
      button.classList.remove(c);
    }
    const svg = button.querySelector("svg");
    if (svg) {
      applyEnhanceIcon(svg);
    }
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      handleButtonClick();
    });
    button.addEventListener("mouseenter", handleMouseEnter);
    button.addEventListener("mouseleave", handleMouseLeave);
    return button;
  };
  var mountButton = () => {
    if (buttonElement && document.contains(buttonElement)) {
      return placeButton();
    }
    const shuffleButton = findNativeShuffleButton();
    if (!shuffleButton) return false;
    injectStyles2();
    if (buttonElement && !document.contains(buttonElement)) {
      buttonElement = null;
    }
    buttonElement = createBetterShuffleButton(shuffleButton);
    shuffleButton.before(buttonElement);
    if (Spicetify.Tippy && Spicetify.TippyProps) {
      buttonTippy = Spicetify.Tippy(buttonElement, {
        ...Spicetify.TippyProps,
        content: "Better Shuffle"
      });
    }
    pendingReshuffleClick = sessionManager.isToggleEnabled();
    setButtonActive(sessionManager.isToggleEnabled());
    refreshTooltip();
    console.info("[Better Shuffle] Playbar button mounted left of shuffle");
    return true;
  };
  var ensureButtonInDom = () => {
    if (!buttonElement || !document.contains(buttonElement)) {
      buttonElement = null;
      mountButton();
      return;
    }
    placeButton();
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
  var handleButtonClick = () => {
    if (!buttonElement || isBusy) return;
    if (!sessionManager.isToggleEnabled()) {
      void enableBetterShuffle();
      return;
    }
    if (pendingReshuffleClick) {
      pendingReshuffleClick = false;
      buttonElement.removeAttribute("data-hover-refresh");
      applyButtonIcon("default");
      refreshTooltip();
      void reshuffleActiveSession();
      return;
    }
    void disableBetterShuffle();
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
          console.warn("[Better Shuffle] Could not find shuffle button to mount playbar control");
        }
      }
    }, 2e3);
  };
  var enableBetterShuffle = async () => {
    if (isBusy) return;
    isBusy = true;
    playClickAnimation();
    try {
      sessionManager.setToggleEnabled(true);
      pendingReshuffleClick = true;
      enforceNativeShuffleOff();
      enableAutoplayGuard();
      updateNativeShuffleGuard();
      setButtonActive(true);
      refreshTooltip();
      Spicetify.showNotification("Building Better Shuffle queue...");
      await reshuffleFromCurrentTrack();
    } catch (error) {
      console.error("[Better Shuffle]", error);
      pendingReshuffleClick = false;
      setButtonActive(false);
      sessionManager.setToggleEnabled(false);
      disableAutoplayGuard();
      sessionManager.endSession();
      updateNativeShuffleGuard();
      refreshTooltip();
      Spicetify.showNotification(
        error instanceof Error ? error.message : "Better Shuffle failed",
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
      console.error("[Better Shuffle]", error);
      Spicetify.showNotification(
        error instanceof Error ? error.message : "Reshuffle failed",
        true
      );
    } finally {
      isBusy = false;
    }
  };
  var disableBetterShuffle = async () => {
    if (isBusy) return;
    isBusy = true;
    playClickAnimation();
    try {
      pendingReshuffleClick = false;
      sessionManager.setToggleEnabled(false);
      disableAutoplayGuard();
      sessionManager.endSession();
      setButtonActive(false);
      buttonElement?.removeAttribute("data-hover-refresh");
      applyButtonIcon("default");
      updateNativeShuffleGuard();
      refreshTooltip();
      await reshuffleOnToggleOff();
      Spicetify.showNotification("Better Shuffle disabled");
    } catch (error) {
      console.error("[Better Shuffle]", error);
      Spicetify.showNotification(
        error instanceof Error ? error.message : "Better Shuffle failed",
        true
      );
    } finally {
      isBusy = false;
    }
  };
  var syncUiFromPlayback = () => {
    sessionManager.setToggleEnabled(true);
    pendingReshuffleClick = true;
    setButtonActive(true);
    enforceNativeShuffleOff();
    updateNativeShuffleGuard();
    refreshTooltip();
    ensureButtonInDom();
  };
  var registerToggleButton = () => {
    registerBetterShuffleUiSync(syncUiFromPlayback);
    waitForShuffleButton();
  };

  // src/app.tsx
  var PLAYBAR_INIT_DELAY_MS = 4e3;
  var initialized = false;
  var playbarInitialized = false;
  var initializePlaybarFeatures = () => {
    if (playbarInitialized) return;
    playbarInitialized = true;
    try {
      registerNativeShuffleGuard();
    } catch (error) {
      console.error("[Better Shuffle] Native shuffle guard failed", error);
    }
    try {
      registerToggleButton();
    } catch (error) {
      console.error("[Better Shuffle] Playbar button registration failed", error);
    }
  };
  var tryRegisterContextMenu = () => {
    try {
      registerContextMenu();
    } catch (error) {
      console.error("[Better Shuffle] Context menu registration failed", error);
    }
  };
  var tryRegisterSettingsMenu = () => {
    try {
      registerSettingsMenu();
    } catch (error) {
      console.error("[Better Shuffle] Settings menu registration failed", error);
    }
  };
  var initializeExtension = () => {
    if (initialized) return;
    initialized = true;
    tryRegisterContextMenu();
    tryRegisterSettingsMenu();
    setTimeout(tryRegisterContextMenu, 2e3);
    setTimeout(tryRegisterSettingsMenu, 2e3);
    Spicetify.Player.addEventListener("songchange", () => {
      enforceNativeShuffleOff();
      if (sessionManager.isToggleEnabled()) {
        updateNativeShuffleGuard();
      }
      void handleSongChange();
    });
    setTimeout(initializePlaybarFeatures, PLAYBAR_INIT_DELAY_MS);
    console.info("[Better Shuffle] Extension initialized");
  };
  var isSpicetifyReady = () => Boolean(
    Spicetify.Platform && Spicetify.Player && Spicetify.URI && Spicetify.ContextMenu?.Item && Spicetify.Menu?.Item && Spicetify.PopupModal
  );
  var waitForSpicetify = () => {
    if (isSpicetifyReady()) {
      initializeExtension();
      return;
    }
    setTimeout(waitForSpicetify, 200);
  };
  var spicetifyEvents = Spicetify.Events;
  spicetifyEvents?.platformLoaded?.addListener?.(waitForSpicetify);
  spicetifyEvents?.webpackLoaded?.addListener?.(() => {
    tryRegisterContextMenu();
    tryRegisterSettingsMenu();
  });
  waitForSpicetify();
})();
