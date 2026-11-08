' Detox Home - entry points.
'
' Main(args)        normal app launch (and ECP deep links: launch/dev?contentId=..&mediaType=..)
' RunScreenSaver()  "Detox Clock" screensaver
'
' Detox Home needs no computer. When Roku Detox installs it from a computer it adds
' pkg:/config.json with what to start with (used once per install):
'   {"seed": "2026-11-08T10:00:00+00:00", "favorites": ["12", "837"], "clock24": false, "simpleMode": false, "tvName": "Living Room TV"}

sub Main(args as Dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)
    scene = screen.CreateScene("HomeScene")
    screen.Show()

    scene.seed = LoadDetoxConfig()

    ' ECP "input?contentId=..&mediaType=.." while the app is already running.
    inputObj = CreateObject("roInput")
    inputObj.SetMessagePort(port)

    ' Deep link from the launch itself (launch/dev?contentId=..&mediaType=..).
    linkSeq = 0
    link = DeepLinkFrom(args)
    if link <> invalid
        linkSeq = linkSeq + 1
        link.seq = linkSeq
        scene.deepLink = link
    end if

    while true
        msg = wait(0, port)
        msgType = type(msg)
        if msgType = "roSGScreenEvent"
            if msg.IsScreenClosed() then return
        else if msgType = "roInputEvent"
            if msg.IsInput()
                link = DeepLinkFrom(msg.GetInfo())
                if link <> invalid
                    linkSeq = linkSeq + 1
                    link.seq = linkSeq
                    scene.deepLink = link
                end if
            end if
        end if
    end while
end sub

sub RunScreenSaver()
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)
    scene = screen.CreateScene("ClockSaverScene")
    screen.Show()

    ' HomeScene keeps the 12/24-hour choice here.
    sec = CreateObject("roRegistrySection", "DetoxHome")
    scene.clock24 = (sec.Read("clock24") = "1")

    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent"
            if msg.IsScreenClosed() then return
        end if
    end while
end sub

' What Roku Detox put in pkg:/config.json, or {} when there's none (installed from a browser,
' or a copy from an older Roku Detox, whose config.json only said how to reach the Mac).
function LoadDetoxConfig() as Object
    text = ReadAsciiFile("pkg:/config.json")
    if not IsStringValue(text) then return {}
    if text = "" then return {}
    cfg = ParseJson(text)
    if type(cfg) <> "roAssociativeArray" then return {}
    return cfg
end function

' Pulls contentId / mediaType out of launch args or an roInputEvent's info.
function DeepLinkFrom(args as Dynamic) as Dynamic
    if type(args) <> "roAssociativeArray" then return invalid
    cid = args.contentId
    if not IsStringValue(cid) then return invalid
    cid = cid.Trim()
    if cid = "" then return invalid
    mediaType = ""
    if IsStringValue(args.mediaType) then mediaType = args.mediaType
    link = { contentId: cid, mediaType: mediaType }
    ' Everything travels inside the link itself: items (contentId=inline), favorites, settings.
    for each field in ["url", "title", "text", "from", "streamFormat", "referer", "ids", "clock24", "simpleMode"]
        if IsStringValue(args[field]) then link[field] = args[field]
    end for
    return link
end function

function IsStringValue(v as Dynamic) as Boolean
    t = type(v)
    return (t = "String" or t = "roString")
end function
