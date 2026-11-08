' VideoView - plays one item with the stock Video node.

sub init()
    m.video = m.top.findNode("video")
    m.stopping = false
    m.video.observeField("state", "onVideoState")
end sub

sub onItemChanged()
    item = m.top.item
    if type(item) <> "roAssociativeArray" then return
    url = asStr(item.url)
    if url = "" then return

    content = CreateObject("roSGNode", "ContentNode")
    content.url = url
    content.title = asStr(item.title)
    content.streamFormat = guessStreamFormat(url, asStr(item.streamFormat))
    content.HttpCertificatesFile = "common:/certs/ca-bundle.crt"
    referer = asStr(item.referer)
    if referer <> ""
        content.HttpHeaders = ["Referer: " + referer]
    end if

    m.stopping = false
    m.video.content = content
    m.video.control = "play"
    m.video.setFocus(true)
end sub

sub onStopNow()
    m.stopping = true
    m.video.control = "stop"
end sub

sub onVideoState()
    if m.stopping then return
    state = m.video.state
    if state = "finished"
        m.stopping = true
        m.top.finished = true
    else if state = "error"
        m.stopping = true
        errText = asStr(m.video.errorMsg)
        if errText = "" then errText = "The video could not be played."
        m.top.playbackError = errText
    end if
end sub

' Use the streamFormat Roku Detox sent if given; otherwise guess from the URL path.
function guessStreamFormat(url as String, given as String) as String
    f = LCase(given.Trim())
    if f <> "" then return f
    path = LCase(url)
    q = Instr(1, path, "?")
    if q > 0 then path = Left(path, q - 1)
    if Instr(1, path, ".m3u8") > 0 then return "hls"
    if Instr(1, path, ".mpd") > 0 then return "dash"
    return "mp4"
end function
