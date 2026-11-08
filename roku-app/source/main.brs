' Detox Home - entry points.
'
' Main(args)        normal app launch (and ECP deep links: launch/dev?contentId=..&mediaType=..)
' RunScreenSaver()  "Detox Clock" screensaver
'
' The Mac program injects pkg:/config.json into the zip:
'   {"mac": "http://192.168.1.10:8642", "token": "...", "tv": "192.168.1.50"}

sub Main(args as Dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)
    scene = screen.CreateScene("HomeScene")
    screen.Show()

    cfg = LoadDetoxConfig()
    if cfg = invalid
        scene.configMissing = true
    else
        scene.config = cfg
    end if

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

    ' HttpTask remembers the Mac's 12/24-hour setting here whenever the config loads.
    sec = CreateObject("roRegistrySection", "DetoxHome")
    scene.clock24 = (sec.Read("clock24") = "1")

    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent"
            if msg.IsScreenClosed() then return
        end if
    end while
end sub

' Returns {mac, token, tv} or invalid when config.json is missing or unusable.
function LoadDetoxConfig() as Dynamic
    text = ReadAsciiFile("pkg:/config.json")
    if text = invalid or text = "" then return invalid
    cfg = ParseJson(text)
    if type(cfg) <> "roAssociativeArray" then return invalid

    mac = cfg.mac
    if not IsStringValue(mac) then return invalid
    mac = mac.Trim()
    while Len(mac) > 0 and Right(mac, 1) = "/"
        mac = Left(mac, Len(mac) - 1)
    end while
    if LCase(Left(mac, 7)) <> "http://" and LCase(Left(mac, 8)) <> "https://" then return invalid

    token = ""
    if IsStringValue(cfg.token) then token = cfg.token
    tvIp = ""
    if IsStringValue(cfg.tv) then tvIp = cfg.tv

    return { mac: mac, token: token, tv: tvIp }
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
    ' Items sent straight from a browser (no Mac) travel inside the link itself.
    for each field in ["url", "title", "text", "from", "streamFormat", "referer"]
        if IsStringValue(args[field]) then link[field] = args[field]
    end for
    return link
end function

function IsStringValue(v as Dynamic) as Boolean
    t = type(v)
    return (t = "String" or t = "roString")
end function
