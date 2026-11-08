' SiteSearch - reads a search results page, and finds the video on a page, on the TV itself.
'
' The same rules as read_results() and find_video() in roku_detox.py (tools/test_site_search.py runs this
' file on a computer and compares the answers). Pure functions: no nodes, no network. Differences on purpose:
'   - a page's address after redirects isn't available on Roku, so links are joined to the address asked for;
'   - a Roku lists an associative array's keys in sorted order, so results read from a page's data can
'     come in a different order than on the page;
'   - words in a search are found without Unicode tables (letters and digits, accented ones included).

function ssState() as Object
    if m.ss = invalid
        m.ss = {
            re: {}
            adHosts: ["doubleclick.net", "googlesyndication.com", "googleadservices.com", "imasdk.googleapis.com", "adservice.google", "amazon-adsystem.com", "adnxs.com", "moatads.com", "taboola.com", "outbrain.com", "popads.net", "popcash.net", "propellerads", "pubmatic.com", "rubiconproject.com", "criteo.", "advertising.com", "adform.net", "smartadserver.com", "spotxchange.com", "springserve.com", "teads.tv", "exoclick.com", "juicyads.com", "trafficjunky", "adsterra", "hilltopads", "onclickads", "admaven", "revcontent.com", "mgid.com", "openx.net", "casalemedia.com", "indexww.com", "sharethrough.com", "media.net", "adsystem", "adserver"]
            urlKeys: ["url", "href", "link", "permalink", "canonicalUrl", "canonical_url", "webpageUrl", "webpage_url", "watchUrl", "watch_url", "shareUrl", "share_url", "pageUrl", "page_url", "path"]
            titleKeys: ["title", "headline", "name"]
            imageKeys: ["thumbnail", "thumbnails", "thumbnailUrl", "thumbnail_url", "image", "images", "poster", "posterUrl", "poster_url", "cover", "coverImage", "cover_image", "contentImage", "artwork", "picture", "img", "still"]
            mediaTypes: { videoobject: true, movie: true, tvseries: true, tvepisode: true, episode: true, tvseason: true, clip: true, musicvideoobject: true, creativework: true, listitem: true }
            mediaKeys: ["duration", "lengthSeconds", "length_seconds", "runtime", "uploadDate", "upload_date", "releaseDate", "release_date", "episodeNumber", "seasonNumber", "viewCount", "view_count"]
            dropParams: { ref: true, ref_src: true, fbclid: true, gclid: true, si: true, pp: true, feature: true, source: true, from: true }
            youtubeHosts: { "youtube.com": true, "youtu.be": true, "music.youtube.com": true, "youtube-nocookie.com": true }
            formatScore: { hls: 3, mp4: 2, dash: 1 }
            entities: { amp: "&", lt: "<", gt: ">", quot: Chr(34), apos: "'", nbsp: Chr(160), copy: Chr(169), reg: Chr(174), trade: Chr(8482), hellip: Chr(8230), mdash: Chr(8212), ndash: Chr(8211), lsquo: Chr(8216), rsquo: Chr(8217), ldquo: Chr(8220), rdquo: Chr(8221), laquo: Chr(171), raquo: Chr(187), bull: Chr(8226), middot: Chr(183), eacute: Chr(233), egrave: Chr(232), aacute: Chr(225), agrave: Chr(224), oacute: Chr(243), uacute: Chr(250), iacute: Chr(237), ntilde: Chr(241), ccedil: Chr(231), ouml: Chr(246), uuml: Chr(252), auml: Chr(228), szlig: Chr(223), deg: Chr(176), times: Chr(215), frac12: Chr(189), euro: Chr(8364), pound: Chr(163), sol: "/", colon: ":", period: ".", comma: ",", equals: "=", quest: "?", num: "#", excl: "!", lpar: "(", rpar: ")" }
        }
    end if
    return m.ss
end function

' A compiled pattern, kept so each is only built once.
function ssRe(name as String, pattern as String, flags as String) as Object
    known = ssState().re
    found = known[name]
    if found = invalid
        found = CreateObject("roRegex", pattern, flags)
        known[name] = found
    end if
    return found
end function

function ssIsStr(v as Dynamic) as Boolean
    t = type(v)
    return (t = "String" or t = "roString")
end function

function ssIsContainer(v as Dynamic) as Boolean
    t = type(v)
    return (t = "roAssociativeArray" or t = "roArray")
end function

function ssSplit(value as String, sep as String) as Object
    out = []
    start = 1
    while true
        at = Instr(start, value, sep)
        if at = 0
            out.Push(Mid(value, start))
            return out
        end if
        out.Push(Mid(value, start, at - start))
        start = at + Len(sep)
    end while
    return out
end function

function ssJoin(items as Object, sep as String) as String
    out = ""
    first = true
    for each item in items
        if not first then out = out + sep
        out = out + item
        first = false
    end for
    return out
end function

function ssSortStrings(items as Object) as Object
    for i = 1 to items.Count() - 1
        item = items[i]
        j = i - 1
        while j >= 0
            if items[j] <= item then exit while
            items[j + 1] = items[j]
            j = j - 1
        end while
        items[j + 1] = item
    end for
    return items
end function

function ssStartsHttp(url as String) as Boolean
    return (Left(url, 7) = "http://" or Left(url, 8) = "https://")
end function

' --- addresses ------------------------------------------------------------------------------------------

function ssUrlParts(url as String) as Object
    out = { scheme: "", netloc: "", host: "", path: "", query: "", fragment: "" }
    rest = url
    at = Instr(1, rest, "#")
    if at > 0
        out.fragment = Mid(rest, at + 1)
        rest = Left(rest, at - 1)
    end if
    at = Instr(1, rest, "?")
    if at > 0
        out.query = Mid(rest, at + 1)
        rest = Left(rest, at - 1)
    end if
    scheme = ssRe("scheme", "^([A-Za-z][A-Za-z0-9+.-]*):", "").Match(rest)
    if scheme.Count() > 1
        out.scheme = LCase(scheme[1])
        rest = Mid(rest, Len(scheme[0]) + 1)
    end if
    if Left(rest, 2) = "//"
        rest = Mid(rest, 3)
        at = Instr(1, rest, "/")
        if at > 0
            out.netloc = Left(rest, at - 1)
            rest = Mid(rest, at)
        else
            out.netloc = rest
            rest = ""
        end if
        host = ssRe("userinfo", "^.*@", "").ReplaceAll(out.netloc, "")
        if Left(host, 1) = "["
            at = Instr(1, host, "]")
            if at > 0 then host = Mid(host, 2, at - 2)
        else
            host = ssRe("hostport", ":.*$", "").ReplaceAll(host, "")
        end if
        out.host = LCase(host)
    end if
    out.path = rest
    return out
end function

function ssUrlBuild(scheme as String, netloc as String, path as String, query as String, fragment as String) as String
    out = path
    if netloc <> ""
        if out <> "" and Left(out, 1) <> "/" then out = "/" + out
        out = "//" + netloc + out
    end if
    if scheme <> "" then out = scheme + ":" + out
    if query <> "" then out = out + "?" + query
    if fragment <> "" then out = out + "#" + fragment
    return out
end function

' urllib.parse.urljoin for http(s) pages.
function ssUrlJoin(base as String, reference as String) as String
    ref = ssRe("urlBreaks", "[\t\r\n]", "").ReplaceAll(reference, "")
    ref = ssRe("urlLead", "^[\x00-\x20]+", "").ReplaceAll(ref, "")
    if ref = "" then return base
    b = ssUrlParts(base)
    r = ssUrlParts(ref)
    scheme = r.scheme
    if scheme = "" then scheme = b.scheme
    if scheme <> b.scheme or (scheme <> "http" and scheme <> "https") then return ref
    if r.netloc <> "" then return ssUrlBuild(scheme, r.netloc, r.path, r.query, r.fragment)
    if r.path = ""
        query = r.query
        if query = "" then query = b.query
        return ssUrlBuild(scheme, b.netloc, b.path, query, r.fragment)
    end if
    if Left(r.path, 1) = "/"
        segments = ssSplit(r.path, "/")
    else
        baseParts = ssSplit(b.path, "/")
        if baseParts[baseParts.Count() - 1] <> "" then baseParts.Pop()
        merged = []
        merged.Append(baseParts)
        merged.Append(ssSplit(r.path, "/"))
        segments = []
        last = merged.Count() - 1
        for i = 0 to last
            if i = 0 or i = last or merged[i] <> "" then segments.Push(merged[i])
        end for
    end if
    resolved = []
    for each segment in segments
        if segment = ".."
            if resolved.Count() > 0 then resolved.Pop()
        else if segment <> "."
            resolved.Push(segment)
        end if
    end for
    tail = segments[segments.Count() - 1]
    if tail = "." or tail = ".." then resolved.Push("")
    path = ssJoin(resolved, "/")
    if path = "" then path = "/"
    return ssUrlBuild(scheme, b.netloc, path, r.query, r.fragment)
end function

function ssUnquote(value as String) as String
    if Instr(1, value, "%") = 0 then return value
    decoded = value.DecodeUriComponent()
    if decoded = "" then return value
    return decoded
end function

function ssQuotePlus(value as String) as String
    out = value.EncodeUriComponent()
    out = out.Replace("%20", "+")
    out = out.Replace("!", "%21")
    out = out.Replace("*", "%2A")
    out = out.Replace("'", "%27")
    out = out.Replace("(", "%28")
    return out.Replace(")", "%29")
end function

' [{k: decoded name, v: decoded value, raw: as written}]
function ssQueryPairs(query as String) as Object
    out = []
    for each raw in ssSplit(query, "&")
        if raw <> ""
            at = Instr(1, raw, "=")
            name = raw
            value = ""
            if at > 0
                name = Left(raw, at - 1)
                value = Mid(raw, at + 1)
            end if
            out.Push({ k: ssUnquote(name.Replace("+", " ")), v: ssUnquote(value.Replace("+", " ")), raw: raw })
        end if
    end for
    return out
end function

function ssPathParts(path as String) as Object
    out = []
    for each part in ssSplit(path, "/")
        if part <> "" then out.Push(part)
    end for
    return out
end function

function ssNoTrailingSlash(text as String) as String
    return ssRe("trailSlash", "/+$", "").ReplaceAll(text, "")
end function

function ssIsAdUrl(url as String) as Boolean
    parts = ssUrlParts(url)
    for each marker in ssState().adHosts
        if Instr(1, parts.host, marker) > 0 then return true
    end for
    return ssRe("adPath", "(^|[/_.-])(ads?|adserver|preroll|pre-roll|vast|vpaid|sponsor(ed)?)([/_.-]|$)", "i").IsMatch(parts.path)
end function

' Addresses on this TV or the home network, written as numbers or a local name.
function ssIsLocalHost(host as String) as Boolean
    if host = "" or host = "localhost" or host = "::1" then return true
    if Right(host, 6) = ".local" or Right(host, 10) = ".localhost" then return true
    return ssRe("localIp", "^(127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)", "").IsMatch(host)
end function

function ssStreamFormat(url as String) as String
    path = LCase(ssUrlParts(url).path)
    if Right(path, 5) = ".m3u8" then return "hls"
    if Right(path, 4) = ".mpd" then return "dash"
    return "mp4"
end function

function ssIsPlayable(url as String) as Boolean
    return ssRe("playable", "\.(m3u8|mp4|m4v|mov|mpd)$", "i").IsMatch(ssUrlParts(url).path)
end function

' "YouTube" or "Netflix" for a link that only opens in that app, else "".
function ssAppFor(link as String) as String
    parts = ssUrlParts(link)
    if parts.scheme <> "http" and parts.scheme <> "https" then return ""
    host = parts.host
    if Left(host, 4) = "www." then host = Mid(host, 5)
    if Left(host, 2) = "m." then host = Mid(host, 3)
    segments = ssPathParts(parts.path)
    if ssState().youtubeHosts.DoesExist(host)
        video = ""
        if host = "youtu.be"
            if segments.Count() > 0 then video = segments[0]
        else if segments.Count() > 0
            if segments[0] = "watch"
                for each pair in ssQueryPairs(parts.query)
                    if pair.k = "v" and pair.v <> "" and video = "" then video = pair.v
                end for
            else if segments.Count() >= 2
                first = segments[0]
                if first = "shorts" or first = "live" or first = "embed" or first = "v" then video = segments[1]
            end if
        end if
        if ssRe("ytid", "^[A-Za-z0-9_-]{11}$", "").IsMatch(video) then return "YouTube"
        return ""
    end if
    if host = "netflix.com" and segments.Count() >= 2
        kind = segments[segments.Count() - 2]
        if (kind = "title" or kind = "watch") and ssRe("digits", "^[0-9]+$", "").IsMatch(segments[segments.Count() - 1]) then return "Netflix"
    end if
    return ""
end function

' --- text in pages --------------------------------------------------------------------------------------

function ssUnescapeHtml(text as String) as String
    if Instr(1, text, "&") = 0 then return text
    entity = ssRe("entity", "&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]{1,31});?", "")
    out = ""
    rest = text
    while true
        found = entity.Match(rest)
        if found.Count() < 2 then return out + rest
        at = Instr(1, rest, found[0])
        out = out + Left(rest, at - 1) + ssEntityValue(found[0], found[1])
        rest = Mid(rest, at + Len(found[0]))
    end while
    return out
end function

function ssEntityValue(whole as String, name as String) as String
    if Left(name, 1) = "#"
        if LCase(Mid(name, 2, 1)) = "x"
            code = Int(Val(Mid(name, 3), 16))
        else
            code = Int(Val(Mid(name, 2)))
        end if
        if code <= 0 or code > 1114111 or (code >= 55296 and code <= 57343) then return Chr(65533)
        return Chr(code)
    end if
    value = ssState().entities[name]
    if value = invalid then return whole
    return value
end function

function ssStripTags(fragment as String) as String
    out = ssRe("tags", "<[^>]+>", "").ReplaceAll(fragment, " ")
    out = ssUnescapeHtml(out)
    out = out.Replace(Chr(160), " ")
    out = ssRe("spaces", "\s+", "").ReplaceAll(out, " ")
    return out.Trim()
end function

function ssIsWordChar(ch as String) as Boolean
    code = Asc(ch)
    if code < 128 then return ((code >= 97 and code <= 122) or (code >= 65 and code <= 90) or (code >= 48 and code <= 57) or code = 95)
    if code < 192 then return (code = 170 or code = 181 or code = 186)
    if code = 215 or code = 247 then return false
    if (code >= 8192 and code <= 8303) or (code >= 12288 and code <= 12351) or code >= 126976 then return false
    return true
end function

' The words of a search: 3 letters or longer when there are any.
function ssWords(query as String) as Object
    found = []
    lower = LCase(query)
    current = ""
    for i = 1 to Len(lower)
        ch = Mid(lower, i, 1)
        if ssIsWordChar(ch)
            current = current + ch
        else if current <> ""
            found.Push(current)
            current = ""
        end if
    end for
    if current <> "" then found.Push(current)
    longer = []
    for each word in found
        if Len(word) >= 3 then longer.Push(word)
    end for
    if longer.Count() > 0 then return longer
    return found
end function

' --- data inside a page's scripts -----------------------------------------------------------------------

sub ssAddBlob(st as Object, raw as String)
    text = raw.Trim()
    size = Len(text)
    if size < 2 or st.used + size > 6000000 or st.blobs.Count() >= 40 then return
    value = ParseJson(text)
    if value <> invalid
        st.blobs.Push(value)
        st.used = st.used + size
    end if
end sub

' From the { or [ at byte start: how many characters it runs for (brackets balanced, strings skipped), or -1.
function ssScanJson(bytes as Object, start as Integer, count as Integer) as Integer
    stack = []
    limit = start + 6000000
    if limit > count then limit = count
    i = start
    chars = 0
    while i < limit
        b = bytes[i]
        if (b and 192) <> 128 then chars = chars + 1
        if b = 34
            i = i + 1
            while i < limit
                b = bytes[i]
                if (b and 192) <> 128 then chars = chars + 1
                if b = 34 then exit while
                if b = 92
                    i = i + 1
                    if i < limit
                        if (bytes[i] and 192) <> 128 then chars = chars + 1
                    end if
                end if
                i = i + 1
            end while
        else if b = 123
            stack.Push(125)
        else if b = 91
            stack.Push(93)
        else if b = 125 or b = 93
            if stack.Count() = 0 then return -1
            if stack.Pop() <> b then return -1
            if stack.Count() = 0 then return chars
        end if
        i = i + 1
    end while
    return -1
end function

' Finds "name = {" and "name = [" in a script and reads the data after each (like ASSIGN_RE and scan_json).
sub ssAssignBlobs(st as Object, body as String)
    if Instr(1, body, "=") = 0 then return
    bytes = CreateObject("roByteArray")
    bytes.FromAsciiString(body)
    count = bytes.Count()
    chars = 0
    named = false      ' the nearest thing before here (spaces aside) is a name
    inName = false
    hasStart = false   ' this name has a character a name can start with
    afterEquals = false
    i = 0
    while i < count
        b = bytes[i]
        isSpace = (b = 32 or (b >= 9 and b <= 13))
        if afterEquals and (b = 123 or b = 91)
            size = ssScanJson(bytes, i, count)
            if size >= 64 then ssAddBlob(st, Mid(body, chars + 1, size))
        end if
        if afterEquals and not isSpace then afterEquals = false
        isLetter = ((b >= 65 and b <= 90) or (b >= 97 and b <= 122) or b = 95 or b = 36)
        if isLetter or (b >= 48 and b <= 57)
            if not inName then hasStart = false
            inName = true
            if isLetter then hasStart = true
            named = hasStart
        else if isSpace
            inName = false
        else
            if b = 61 and named then afterEquals = true
            named = false
            inName = false
        end if
        if (b and 192) <> 128 then chars = chars + 1
        i = i + 1
    end while
end sub

function ssPageData(page as String) as Object
    st = { blobs: [], used: 0 }
    jsonScript = ssRe("jsonScript", "<script\b[^>]*\btype=[""']application/(?:ld\+json|json)[""'][^>]*>([\s\S]*?)</script>", "i")
    comments = ssRe("cdata", "^\s*(?:<!--|<!\[CDATA\[)|(?:-->|\]\]>)\s*$", "")
    for each found in jsonScript.MatchAll(page)
        ssAddBlob(st, comments.ReplaceAll(found[1], ""))
    end for
    notRead = ssRe("skipScript", "\bsrc=|application/(?:ld\+json|json)", "i")
    jsonParse = ssRe("jsonParse", "JSON\.parse\(\s*""((?:\\[\s\S]|[^""\\])*)""\s*\)", "")
    hexEscape = ssRe("hexEscape", "\\x[0-9a-fA-F]{2}", "")
    for each script in ssRe("script", "<script\b([^>]*)>([\s\S]*?)</script>", "i").MatchAll(page)
        if not notRead.IsMatch(script[1])
            ssAssignBlobs(st, script[2])
            for each parsed in jsonParse.MatchAll(script[2])
                if Len(parsed[1]) >= 64
                    source = parsed[1]
                    for each hex in hexEscape.MatchAll(source)
                        source = source.Replace(hex[0], "\u00" + Mid(hex[0], 3))
                    end for
                    inner = ParseJson(Chr(34) + source + Chr(34))
                    if ssIsStr(inner) then ssAddBlob(st, inner)
                end if
            end for
        end if
    end for
    return st.blobs
end function

function ssDataText(value as Dynamic) as String
    if ssIsStr(value) then return value
    if type(value) <> "roAssociativeArray" then return ""
    for each key in ["simpleText", "content", "text"]
        if ssIsStr(value[key]) then return value[key]
    end for
    runs = value.runs
    if type(runs) <> "roArray" then return ""
    out = ""
    for each piece in runs
        if type(piece) = "roAssociativeArray"
            if ssIsStr(piece.text) then out = out + piece.text
        end if
    end for
    return out
end function

function ssDataTitle(node as Object, depth as Integer) as String
    for each key in ssState().titleKeys
        text = ssStripTags(ssDataText(node[key]))
        if text <> "" then return text
    end for
    metadata = node.metadata
    if depth < 3 and type(metadata) = "roAssociativeArray"
        title = ssDataTitle(metadata, depth + 1)
        if title <> "" then return title
        for each key in metadata.Keys()
            value = metadata[key]
            if type(value) = "roAssociativeArray"
                title = ssDataTitle(value, depth + 1)
                if title <> "" then return title
            end if
        end for
    end if
    return ""
end function

function ssDataImage(value as Dynamic, depth as Integer) as Dynamic
    if depth > 5 then return invalid
    if ssIsStr(value)
        if ssStartsHttp(value) or Left(value, 1) = "/" then return value
        return invalid
    end if
    if type(value) = "roArray"
        for i = value.Count() - 1 to 0 step -1
            found = ssDataImage(value[i], depth + 1)
            if found <> invalid then return found
        end for
        return invalid
    end if
    if type(value) <> "roAssociativeArray" then return invalid
    for each key in ["url", "src", "contentUrl"]
        if ssIsStr(value[key])
            found = ssDataImage(value[key], depth + 1)
            if found <> invalid then return found
        end if
    end for
    for each key in value.Keys()
        if ssIsContainer(value[key])
            found = ssDataImage(value[key], depth + 1)
            if found <> invalid then return found
        end if
    end for
    return invalid
end function

function ssUsableImage(url as Dynamic, finalUrl as String) as Dynamic
    if not ssIsStr(url) then return invalid
    if url = "" then return invalid
    absolute = ssUrlJoin(finalUrl, ssUnescapeHtml(url))
    if Left(absolute, 8) = "https://" and not ssIsAdUrl(absolute) then return absolute
    return invalid
end function

function ssFirstImage(node as Object, finalUrl as String) as Dynamic
    for each key in ssState().imageKeys
        if node.DoesExist(key)
            image = ssUsableImage(ssDataImage(node[key], 0), finalUrl)
            if image <> invalid then return image
        end if
    end for
    return invalid
end function

function ssUsableLink(absolute as String, finalUrl as String, baseRoot as String) as Boolean
    parts = ssUrlParts(absolute)
    if parts.scheme <> "http" and parts.scheme <> "https" then return false
    if Right(parts.host, Len(baseRoot)) <> baseRoot then return false
    if ssIsAdUrl(absolute) then return false
    if ssRe("allSlashes", "^/*$", "").IsMatch(parts.path) then return false
    if ssRe("navPath", "(^|/)(login|log-in|signin|sign-in|signup|sign-up|register|account|profile|privacy|terms|contact|about|faq|help|dmca|cookie|cookies|legal|advertise|careers|genre|genres|category|categories|tag|tags|search|feed|rss|sitemap|cart|subscribe|donate|share)(/|$)", "i").IsMatch(parts.path) then return false
    if ssRe("navQuery", "(^|&)(page|sort|filter|lang|order|ref)=", "i").IsMatch(parts.query) then return false
    return ssNoTrailingSlash(absolute) <> ssNoTrailingSlash(finalUrl)
end function

' One result from a piece of a page's data: {entry, sure}, or invalid.
function ssDataEntry(node as Object, finalUrl as String, baseRoot as String) as Dynamic
    entry = invalid
    sure = false
    videoId = node.videoId
    if not ssIsStr(videoId) and node.DoesExist("contentType")
        if Instr(1, UCase(asStr(node.contentType)), "VIDEO") > 0 then videoId = node.contentId
    end if
    if ssIsStr(videoId)
        if ssRe("ytid", "^[A-Za-z0-9_-]{11}$", "").IsMatch(videoId)
            title = ssDataTitle(node, 0)
            if title <> ""
                entry = { title: title, url: "https://www.youtube.com/watch?v=" + videoId, image: ssFirstImage(node, finalUrl) }
                sure = (baseRoot = "youtube.com")
            end if
        end if
    end if
    if entry = invalid
        urlKey = ""
        for each key in ssState().urlKeys
            if ssIsStr(node[key])
                if node[key] <> ""
                    urlKey = key
                    exit for
                end if
            end if
        end for
        if urlKey = "" then return invalid
        title = ssDataTitle(node, 0)
        if title = "" then return invalid
        absolute = ssUrlJoin(finalUrl, ssUnescapeHtml(node[urlKey]))
        if not ssUsableLink(absolute, finalUrl, baseRoot) then return invalid
        kinds = node["@type"]
        if type(kinds) <> "roArray" then kinds = [kinds]
        for each kind in kinds
            if ssIsStr(kind)
                if ssState().mediaTypes.DoesExist(LCase(kind)) then sure = true
            end if
        end for
        for each key in ssState().mediaKeys
            if node.DoesExist(key) then sure = true
        end for
        entry = { title: title, url: absolute, image: ssFirstImage(node, finalUrl) }
    end if
    size = Len(entry.title)
    if size < 2 or size > 140 then return invalid
    return { entry: entry, sure: sure }
end function

function ssDataResults(page as String, finalUrl as String, baseRoot as String) as Object
    out = []
    budget = 300000
    for each blob in ssPageData(page)
        stack = [blob]
        while stack.Count() > 0 and budget > 0
            node = stack.Pop()
            budget = budget - 1
            if type(node) = "roArray"
                for i = node.Count() - 1 to 0 step -1
                    stack.Push(node[i])
                end for
            else if type(node) = "roAssociativeArray"
                names = node.Keys()
                for i = names.Count() - 1 to 0 step -1
                    child = node[names[i]]
                    if ssIsContainer(child) then stack.Push(child)
                end for
                found = ssDataEntry(node, finalUrl, baseRoot)
                if found <> invalid then out.Push(found)
            end if
        end while
    end for
    return out
end function

' --- reading a results page ------------------------------------------------------------------------------

' A result's address without tracking bits, so the same video found twice counts once.
function ssResultKey(url as String) as String
    parts = ssUrlParts(url)
    kept = []
    for each pair in ssQueryPairs(parts.query)
        low = LCase(pair.k)
        if Left(low, 4) <> "utm_" and not ssState().dropParams.DoesExist(low) then kept.Push(pair.raw)
    end for
    host = parts.host
    if Left(host, 4) = "www." then host = Mid(host, 5)
    key = host + ssNoTrailingSlash(parts.path)
    if kept.Count() > 0 then key = key + "?" + ssJoin(kept, "&")
    return key
end function

' Links in a results list look alike: same first folder, same depth, same query names.
function ssLinkShape(url as String) as String
    parts = ssUrlParts(url)
    segments = ssPathParts(parts.path)
    seen = {}
    seen.SetModeCaseSensitive()
    names = []
    for each pair in ssQueryPairs(parts.query)
        if not seen.DoesExist(pair.k)
            seen[pair.k] = true
            names.Push(pair.k)
        end if
    end for
    first = ""
    if segments.Count() > 0 then first = LCase(segments[0])
    return parts.host + "|" + first + "|" + segments.Count().ToStr() + "|" + ssJoin(ssSortStrings(names), ",")
end function

function ssScore(entry as Object, words as Object) as Integer
    if entry.DoesExist("score") then return entry.score
    haystack = LCase(entry.title + " " + ssUnquote(ssUrlParts(entry.url).path))
    total = 0
    for each word in words
        if Instr(1, haystack, word) > 0 then total = total + 1
    end for
    entry.score = total
    return total
end function

' Reads the results on a search results page: {results: [{title, url, image, app}]} or {error}.
function ssReadResults(finalUrl as String, html as String, query as String) as Object
    labels = ssSplit(ssUrlParts(finalUrl).host, ".")
    baseRoot = labels[labels.Count() - 1]
    if labels.Count() >= 2 then baseRoot = labels[labels.Count() - 2] + "." + baseRoot
    fromData = ssDataResults(html, finalUrl, baseRoot)
    ' Menus, headers and footers are never results.
    page = ssRe("notResults", "<(script|style|noscript|svg|header|nav|footer|aside)\b[\s\S]*?</\1>", "i").ReplaceAll(html, " ")
    words = ssWords(query)

    links = []
    seen = {}
    seen.SetModeCaseSensitive()
    imageRe = ssRe("linkImage", "<img[^>]+(?:data-src|data-original|data-lazy-src|src)=[""']([^""']+)", "i")
    altRe = ssRe("linkAlt", "<img[^>]+alt=[""']([^""']+)", "i")
    titleRe = ssRe("linkTitle", "\btitle=[""']([^""']+)", "i")
    for each found in ssRe("link", "<a\b([^>]*?)href=[""']([^""'#]+)[""']([^>]*)>([\s\S]*?)</a>", "i").MatchAll(page)
        absolute = ssUrlJoin(finalUrl, ssUnescapeHtml(found[2]))
        if ssUsableLink(absolute, finalUrl, baseRoot)
            inner = found[4]
            title = ""
            titleAttr = titleRe.Match(found[1] + found[3])
            if titleAttr.Count() > 1 then title = titleAttr[1]
            if title = "" then title = ssStripTags(inner)
            if title = ""
                alt = altRe.Match(inner)
                if alt.Count() > 1 then title = alt[1]
            end if
            title = ssStripTags(title)
            if Len(title) >= 2 and Len(title) <= 140
                image = imageRe.Match(inner)
                imageUrl = invalid
                if image.Count() > 1 then imageUrl = ssUsableImage(image[1], finalUrl)
                key = ssResultKey(absolute)
                if seen.DoesExist(key)
                    entry = seen[key]
                    if entry.image = invalid then entry.image = imageUrl
                    if Len(title) > Len(entry.title) then entry.title = title
                else
                    entry = { title: title, url: absolute, image: imageUrl }
                    seen[key] = entry
                    links.Push(entry)
                end if
            end if
        end if
    end for

    ' The biggest set of look-alike links that mentions the search words is the results list, kept whole.
    shapes = {}
    shapes.SetModeCaseSensitive()
    shapeOrder = []
    for each entry in links
        shape = ssLinkShape(entry.url)
        if not shapes.DoesExist(shape)
            shapes[shape] = []
            shapeOrder.Push(shape)
        end if
        shapes[shape].Push(entry)
    end for
    grid = []
    for each shape in shapeOrder
        group = shapes[shape]
        if group.Count() >= 5 and group.Count() > grid.Count()
            matches = false
            for each entry in group
                if ssScore(entry, words) > 0 then matches = true
            end for
            if matches then grid = group
        end if
    end for
    for each entry in grid
        entry.inGrid = true
    end for

    sure = []
    maybe = []
    for each item in fromData
        if item.sure then sure.Push(item.entry)
    end for
    sure.Append(grid)
    for each item in fromData
        if not item.sure
            if ssScore(item.entry, words) > 0 then maybe.Push(item.entry)
        end if
    end for
    for each entry in links
        if not asBool(entry.inGrid)
            if ssScore(entry, words) > 0 then maybe.Push(entry)
        end if
    end for
    ssSortMaybe(maybe, words)

    results = []
    keys = {}
    keys.SetModeCaseSensitive()
    combined = []
    combined.Append(sure)
    combined.Append(maybe)
    for each entry in combined
        key = ssResultKey(entry.url)
        if keys.DoesExist(key)
            kept = keys[key]
            if kept.image = invalid then kept.image = entry.image
        else
            keys[key] = entry
            results.Push(entry)
        end if
    end for
    if results.Count() = 0 then return { error: "No results could be read from this page. The site may build its results with scripts." }
    out = []
    for each entry in results
        if out.Count() >= 20 then exit for
        out.Push({ title: entry.title, url: entry.url, image: entry.image, app: ssAppFor(entry.url) })
    end for
    return { results: out }
end function

' Most search words first, then those with a picture; otherwise in page order.
sub ssSortMaybe(items as Object, words as Object)
    for i = 1 to items.Count() - 1
        item = items[i]
        rank = ssRank(item, words)
        j = i - 1
        while j >= 0
            if ssRank(items[j], words) >= rank then exit while
            items[j + 1] = items[j]
            j = j - 1
        end while
        items[j + 1] = item
    end for
end sub

function ssRank(entry as Object, words as Object) as Integer
    rank = ssScore(entry, words) * 2
    if entry.image <> invalid then rank = rank + 1
    return rank
end function

' --- finding the video on a page -------------------------------------------------------------------------

function ssPageMeta(page as String, names as Object) as Dynamic
    for each name in names
        found = ssRe("metaA" + name, "<meta[^>]+(?:property|name)=[""']" + name + "[""'][^>]*content=[""']([^""']+)", "i").Match(page)
        if found.Count() < 2 then found = ssRe("metaB" + name, "<meta[^>]+content=[""']([^""']+)[""'][^>]*(?:property|name)=[""']" + name + "[""']", "i").Match(page)
        if found.Count() > 1 then return ssUnescapeHtml(found[1])
    end for
    return invalid
end function

function ssPageTitle(page as String) as String
    title = ssPageMeta(page, ["og:title", "twitter:title"])
    if title <> invalid then return title
    found = ssRe("titleTag", "<title[^>]*>([^<]+)</title>", "i").Match(page)
    if found.Count() > 1 then return ssUnescapeHtml(found[1]).Trim()
    return ""
end function

function ssCleanVideoLink(raw as String, baseUrl as String) as Dynamic
    clean = ssUnescapeHtml(raw)
    clean = clean.Replace("\/", "/")
    clean = clean.Replace("\u002F", "/")
    clean = clean.Replace("\u0026", "&")
    absolute = ssUrlJoin(baseUrl, clean)
    if ssStartsHttp(absolute) and not ssIsAdUrl(absolute) then return absolute
    return invalid
end function

function ssAddUnique(out as Object, known as Object, raw as String, baseUrl as String) as Dynamic
    absolute = ssCleanVideoLink(raw, baseUrl)
    if absolute = invalid then return invalid
    if known.DoesExist(absolute) then return invalid
    known[absolute] = true
    out.Push(absolute)
    return absolute
end function

function ssVideoCandidates(page as String, baseUrl as String) as Object
    out = []
    known = {}
    known.SetModeCaseSensitive()
    for each names in [["og:video:secure_url", "og:video:url", "og:video"], ["twitter:player:stream"]]
        value = ssPageMeta(page, names)
        if value <> invalid then ssAddUnique(out, known, value, baseUrl)
    end for
    for each found in ssRe("videoTag", "<(?:video|source)[^>]+src=[""']([^""']+)", "i").MatchAll(page)
        ssAddUnique(out, known, found[1], baseUrl)
    end for
    for each found in ssRe("contentUrl", """contentUrl""\s*:\s*""([^""]+)""", "").MatchAll(page)
        ssAddUnique(out, known, found[1], baseUrl)
    end for
    for each found in ssRe("videoUrl", "https?:(?:\\?/){2}[^\s""'<>]+?\.(?:m3u8|mp4|m4v|mov|mpd)(?:\?[^\s""'<>]*)?", "i").MatchAll(page)
        ssAddUnique(out, known, found[0], baseUrl)
    end for
    for each found in ssRe("videoPath", "[""']((?:\\?/)[^\s""'<>]+?\.(?:m3u8|mp4|m4v|mov|mpd)(?:\?[^\s""'<>]*)?)[""']", "i").MatchAll(page)
        ssAddUnique(out, known, found[1], baseUrl)
    end for
    return out
end function

' [[url, format]] for <video>/<source> tags whose type says what they are.
function ssTypedSources(page as String, baseUrl as String) as Object
    out = []
    known = {}
    known.SetModeCaseSensitive()
    for each found in ssRe("mediaTag", "<(?:video|source)\b[^>]*>", "i").MatchAll(page)
        src = ssRe("tagSrc", "\ssrc=[""']([^""']+)", "i").Match(found[0])
        kind = ssRe("tagType", "\stype=[""']([^""']+)", "i").Match(found[0])
        if src.Count() > 1 and kind.Count() > 1
            lowered = LCase(kind[1])
            format = ""
            if Instr(1, lowered, "mpegurl") > 0
                format = "hls"
            else if Instr(1, lowered, "dash+xml") > 0
                format = "dash"
            else if Left(lowered, 9) = "video/mp4"
                format = "mp4"
            end if
            if format <> ""
                absolute = ssCleanVideoLink(src[1], baseUrl)
                if absolute <> invalid
                    if not known.DoesExist(absolute)
                        known[absolute] = true
                        out.Push([absolute, format])
                    end if
                end if
            end if
        end if
    end for
    return out
end function

' Embedded players to look in.
function ssVideoFrames(page as String, baseUrl as String) as Object
    out = []
    known = {}
    known.SetModeCaseSensitive()
    for each found in ssRe("iframe", "<iframe[^>]+src=[""']([^""']+)", "i").MatchAll(page)
        ssAddUnique(out, known, found[1], baseUrl)
    end for
    for each found in ssRe("embedUrl", """embedUrl""\s*:\s*""([^""]+)""", "").MatchAll(page)
        ssAddUnique(out, known, found[1], baseUrl)
    end for
    return out
end function

' The best video on a page: {url, format}, or invalid. YouTube and Netflix only open in their apps, which an
' app on the TV can't start, so a file wins over an embedded one here: {url, format: "app"} only if there's no file.
function ssPickVideo(candidates as Object, typed as Object) as Dynamic
    best = invalid
    score = ssState().formatScore
    app = invalid
    known = {}
    known.SetModeCaseSensitive()
    for each candidate in candidates
        if app = invalid and ssAppFor(candidate) <> "" then app = candidate
        if ssIsPlayable(candidate)
            known[candidate] = true
            format = ssStreamFormat(candidate)
            if best = invalid
                best = { url: candidate, format: format }
            else if score[format] > score[best.format]
                best = { url: candidate, format: format }
            end if
        end if
    end for
    for each pair in typed
        if not known.DoesExist(pair[0])
            if best = invalid
                best = { url: pair[0], format: pair[1] }
            else if score[pair[1]] > score[best.format]
                best = { url: pair[0], format: pair[1] }
            end if
        end if
    end for
    if best <> invalid then return best
    if app <> invalid then return { url: app, format: "app" }
    return invalid
end function

' A site's search address with the words put in, or "" if it can't be used.
function ssSearchUrl(search as String, query as String) as String
    authority = ssRe("searchHost", "^https?://([^/?#]+)", "i").Match(search)
    if authority.Count() < 2 then return ""
    if Instr(1, authority[1], "{q}") > 0 then return ""
    if ssRe("searchBad", "[\x00-\x20\x7f\\]", "").IsMatch(search) then return ""
    return search.Replace("{q}", ssQuotePlus(query))
end function
