' FindVideoTask - the TV's find_video(): a direct link, then the page, then up to 3 embedded players.

sub init()
    m.top.functionName = "findVideo"
end sub

sub findVideo()
    m.top.response = locate(m.top.request)
end sub

function played(url as String, title as String, format as String, referer as String) as Object
    return { url: url, title: title, streamFormat: format, referer: referer }
end function

function locate(req as Object) as Object
    url = asStr(req.url)
    title = asStr(req.title)
    slot = asStr(req.slot)
    if not ssStartsHttp(url) then return { error: "That link can't be opened on the TV." }
    if ssIsPlayable(url) then return played(url, title, ssStreamFormat(url), "")
    contentType = sfContentType(url)
    if sfIsVideoType(contentType) then return played(url, title, videoFormat(contentType), "")

    fetched = sfFetchPage(url, "", slot)
    if ssIsStr(fetched.error) then return { error: fetched.error }
    if asBool(fetched.video) then return played(url, title, videoFormat(asStr(fetched.contentType)), "")
    page = fetched.page
    found = ssPickVideo(ssVideoCandidates(page, url), ssTypedSources(page, url))
    if found <> invalid
        if found.format <> "app" then return played(found.url, title, found.format, url)
    end if

    ' Many sites put the player in an embedded frame. Look one level in (never into ad frames).
    frames = ssVideoFrames(page, url)
    for i = 0 to frames.Count() - 1
        if i >= 3 then exit for
        frame = frames[i]
        inner = sfFetchPage(frame, url, slot)
        if asBool(inner.video) then return played(frame, title, ssStreamFormat(frame), url)
        if ssIsStr(inner.page)
            framed = ssPickVideo(ssVideoCandidates(inner.page, frame), ssTypedSources(inner.page, frame))
            if framed <> invalid
                if framed.format <> "app" then return played(framed.url, title, framed.format, frame)
                if found = invalid then found = framed
            end if
        end if
    end for

    if found <> invalid
        return { error: "This video only opens in the " + ssAppFor(found.url) + " app, and apps on the TV can't open other apps. Find it from the Roku home screen." }
    end if
    if ssRe("drm", "widevine|fairplay|playready|\bdrm\b", "i").IsMatch(page)
        return { error: "This site locks its videos (DRM), so they can't play here. If it has a Roku app, use that." }
    end if
    return { error: "Couldn't find a video on that page. Some sites load their videos in ways the TV can't see." }
end function

function videoFormat(contentType as String) as String
    if Instr(1, LCase(contentType), "mpegurl") > 0 then return "hls"
    return "mp4"
end function
