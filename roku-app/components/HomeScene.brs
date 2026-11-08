' HomeScene - home screen, message / notice / video screens, and all talk with the Mac.
'
' Modes: "home" | "message" (also notices) | "video" | "loading" | "setup" (config.json missing)

sub init()
    ' Text sizes (see setFont in DetoxUtils.brs).
    applyFonts([["clockLabel", 120, true], ["dateLabel", 40, false], ["tvNameLabel", 32, false], ["appsTitle", 36, true], ["statusLabel", 40, false], ["emptyLabel", 44, false], ["inputsTitle", 36, true], ["bannerLabel", 28, false], ["loadingLabel", 56, false], ["overlayTitle", 72, true], ["overlayText", 40, false], ["homeSceneText1", 72, true], ["homeSceneText2", 52, false]])
    m.top.backgroundURI = ""
    m.top.backgroundColor = "0x10161FFF"

    m.homeGroup = m.top.findNode("homeGroup")
    m.clockLabel = m.top.findNode("clockLabel")
    m.dateLabel = m.top.findNode("dateLabel")
    m.tvNameLabel = m.top.findNode("tvNameLabel")
    m.appsTitle = m.top.findNode("appsTitle")
    m.statusLabel = m.top.findNode("statusLabel")
    m.emptyLabel = m.top.findNode("emptyLabel")
    m.appsArea = m.top.findNode("appsArea")
    m.inputsTitle = m.top.findNode("inputsTitle")
    m.inputsArea = m.top.findNode("inputsArea")
    m.banner = m.top.findNode("banner")
    m.bannerLabel = m.top.findNode("bannerLabel")
    m.messageView = m.top.findNode("messageView")
    m.videoView = m.top.findNode("videoView")
    m.loadingGroup = m.top.findNode("loadingGroup")
    m.overlay = m.top.findNode("overlay")
    m.overlayTitle = m.top.findNode("overlayTitle")
    m.overlayText = m.top.findNode("overlayText")
    m.setupGroup = m.top.findNode("setupGroup")
    m.clockTimer = m.top.findNode("clockTimer")
    m.retryTimer = m.top.findNode("retryTimer")
    m.overlayTimer = m.top.findNode("overlayTimer")

    m.cfg = invalid            ' {mac, token, tv} from config.json
    m.tv = invalid             ' last good /api/tv/config response
    m.tvSig = ""               ' FormatJson of it, to skip rebuilding when nothing changed
    m.clock24 = false
    m.simple = false
    m.mode = "home"
    m.rows = []                ' [{group, items, tiles, x0, y, pitch, start, visibleCount, scroll}]
    m.focusRow = 0
    m.focusCol = 0
    m.tasks = {}               ' in-flight HttpTask nodes by id
    m.taskSeq = 0
    m.itemSeq = 0
    m.configInFlight = false
    m.pendingLink = invalid
    m.configMissing = false
    m.bannerText = ""

    m.clockTimer.observeField("fire", "updateClock")
    m.retryTimer.observeField("fire", "onRetryTimer")
    m.overlayTimer.observeField("fire", "hideOverlay")
    m.videoView.observeField("finished", "onVideoFinished")
    m.videoView.observeField("playbackError", "onVideoError")

    setClockLayout(false)
    updateClock()
    m.clockTimer.control = "start"
    m.top.setFocus(true)
end sub

' ---------------------------------------------------------------- fields from main.brs

sub onConfigSet()
    cfg = m.top.config
    if type(cfg) <> "roAssociativeArray" then return
    if asStr(cfg.mac) = "" then return
    m.cfg = { mac: asStr(cfg.mac), token: asStr(cfg.token), tv: asStr(cfg.tv) }
    m.configMissing = false
    fetchConfig()
    m.retryTimer.control = "start"
    if m.pendingLink <> invalid
        link = m.pendingLink
        m.pendingLink = invalid
        openItem(link.contentId)
    end if
end sub

sub onConfigMissing()
    if m.top.configMissing <> true then return
    ' Installed without a Mac (from a browser): a clock home screen that still shows
    ' videos, messages and notices sent straight to it.
    m.configMissing = true
    m.retryTimer.control = "stop"
    m.appsTitle.visible = false
    m.emptyLabel.visible = false
    m.statusLabel.text = "Send videos and messages here from Roku Detox in your browser. Your favorite apps show up here when Roku Detox runs on a computer at home."
    m.statusLabel.visible = true
    setMode("home")
end sub

sub onDeepLink()
    link = m.top.deepLink
    if type(link) <> "roAssociativeArray" then return
    contentId = asStr(link.contentId)
    if contentId = "" then return
    if contentId = "inline"
        showInline(link)
        return
    end if
    if m.configMissing then return
    openItem(contentId)
end sub

' An item carried in the deep link itself: {mediaType, url, title, text, from, ...}.
sub showInline(link as Object)
    kind = LCase(asStr(link.mediaType))
    m.itemSeq = m.itemSeq + 1   ' any item still loading from the Mac is now out of date
    if kind = "video"
        showVideo(link)
    else if kind = "message"
        showMessage("", asStr(link.text), asStr(link.from))
    else if kind = "notice"
        showNotice(asStr(link.title), asStr(link.text))
    end if
end sub

' ---------------------------------------------------------------- clock

sub setClockLayout(simple as Boolean)
    if simple
        setFont(m.clockLabel, 96, true)
        m.clockLabel.translation = [120, 50]
        setFont(m.dateLabel, 36, false)
        m.dateLabel.translation = [124, 170]
    else
        setFont(m.clockLabel, 120, true)
        m.clockLabel.translation = [120, 60]
        setFont(m.dateLabel, 40, false)
        m.dateLabel.translation = [124, 210]
    end if
end sub

sub updateClock()
    dt = localNow()
    m.clockLabel.text = formatTime(dt, m.clock24)
    m.dateLabel.text = formatDate(dt)
end sub

' ---------------------------------------------------------------- modes

sub setMode(mode as String)
    m.mode = mode
    m.homeGroup.visible = (mode = "home")
    m.messageView.visible = (mode = "message")
    m.videoView.visible = (mode = "video")
    m.loadingGroup.visible = (mode = "loading")
    m.setupGroup.visible = (mode = "setup")
    if mode <> "home" then hideOverlay()
    updateBanner()
    ' The Video node takes focus itself (for trickplay); everything else is handled here.
    if mode <> "video" then m.top.setFocus(true)
end sub

sub goHome()
    stopVideo()
    setMode("home")
    applyHighlight()
end sub

sub stopVideo()
    m.videoView.stopNow = true
end sub

sub showMessage(title as String, text as String, sender as String)
    stopVideo()
    m.messageView.message = { title: title, text: text, from: sender }
    setMode("message")
end sub

sub showNotice(title as String, text as String)
    if title = "" then title = "Notice"
    showMessage(title, text, "")
end sub

sub showVideo(data as Object)
    url = asStr(data.url)
    if url = ""
        showNotice("Couldn't play this video", "No video address was sent.")
        return
    end if
    setMode("video")
    m.videoView.item = {
        title: asStr(data.title),
        url: url,
        streamFormat: asStr(data.streamFormat),
        referer: asStr(data.referer)
    }
end sub

sub onVideoFinished()
    if m.mode = "video" then goHome()
end sub

sub onVideoError()
    if m.mode <> "video" then return
    errText = asStr(m.videoView.playbackError)
    showNotice("Couldn't play this video", errText)
end sub

' ---------------------------------------------------------------- banner + overlay

sub setBanner(text as String)
    m.bannerText = text
    if text <> "" then m.bannerLabel.text = text
    updateBanner()
end sub

sub updateBanner()
    m.banner.visible = (m.bannerText <> "" and (m.mode = "home" or m.mode = "loading"))
end sub

function reachText(resp as Object) as String
    code = asInt(resp.code, 0)
    if code = 401 or code = 403 then return "Roku Detox on your Mac didn't accept this TV"
    return "Can't reach Roku Detox on your Mac"
end function

sub showOverlay(title as String, text as String, seconds as Integer)
    m.overlayTitle.text = title
    m.overlayText.text = text
    m.overlay.visible = true
    m.overlayTimer.control = "stop"
    m.overlayTimer.duration = seconds
    m.overlayTimer.control = "start"
end sub

sub hideOverlay()
    m.overlay.visible = false
    m.overlayTimer.control = "stop"
end sub

' ---------------------------------------------------------------- HTTP

' Starts one HttpTask. extra is kept and handed back with the response.
sub startRequest(tag as String, method as String, path as String, query as Dynamic, body as Dynamic, extra as Object)
    if m.cfg = invalid then return
    m.taskSeq = m.taskSeq + 1
    key = "req" + m.taskSeq.ToStr()
    req = { tag: tag, method: method, url: m.cfg.mac + path, token: m.cfg.token }
    if query <> invalid then req.query = query
    if body <> invalid then req.body = FormatJson(body)

    task = CreateObject("roSGNode", "HttpTask")
    task.id = key
    task.request = req
    task.observeField("response", "onHttpResponse")
    extra.tag = tag
    extra.node = task          ' keeps the task alive until it answers
    m.tasks[key] = extra
    task.control = "RUN"
end sub

sub onHttpResponse(event as Object)
    task = event.getRoSGNode()
    if task = invalid then return
    key = task.id
    task.unobserveField("response")
    info = m.tasks[key]
    if info = invalid then return
    m.tasks.Delete(key)

    resp = event.getData()
    if type(resp) <> "roAssociativeArray" then resp = { ok: false, code: 0, error: "no response" }

    if info.tag = "config"
        onConfigResponse(resp)
    else if info.tag = "launch"
        onLaunchResponse(resp, info)
    else if info.tag = "item"
        onItemResponse(resp, info)
    end if
end sub

sub fetchConfig()
    if m.cfg = invalid or m.configInFlight then return
    m.configInFlight = true
    startRequest("config", "GET", "/api/tv/config", invalid, invalid, {})
end sub

sub onRetryTimer()
    ' Every 30 s: retry after a failure, and pick up favorites changed on the Mac.
    fetchConfig()
end sub

sub onConfigResponse(resp as Object)
    m.configInFlight = false
    data = resp.data
    if asBool(resp.ok) and type(data) = "roAssociativeArray"
        setBanner("")
        sig = FormatJson(data)
        if sig <> m.tvSig or m.tv = invalid
            m.tvSig = sig
            m.tv = data
            applyTvConfig()
        end if
    else
        setBanner(reachText(resp))
        if m.tv = invalid
            m.statusLabel.text = "Your apps will show up here once Roku Detox on your Mac can be reached. Trying again every 30 seconds."
            m.statusLabel.visible = true
        end if
    end if
end sub

sub applyTvConfig()
    m.clock24 = asBool(m.tv.clock24)
    m.simple = asBool(m.tv.simpleMode)
    m.tvNameLabel.text = asStr(m.tv.tvName)
    setClockLayout(m.simple)
    updateClock()
    buildHome()
end sub

' ---------------------------------------------------------------- home layout

sub buildHome()
    clearChildren(m.appsArea)
    clearChildren(m.inputsArea)
    m.rows = []
    m.statusLabel.visible = false

    favs = cleanItems(asArray(m.tv.favorites))
    inputs = cleanItems(asArray(m.tv.inputs))

    if m.simple
        layoutSimple(favs)
    else
        layoutNormal(favs, inputs)
    end if

    ' Keep focus where it was, as far as the new rows allow.
    if m.rows.Count() = 0
        m.focusRow = 0
        m.focusCol = 0
    else
        if m.focusRow > m.rows.Count() - 1 then m.focusRow = m.rows.Count() - 1
        lastCol = m.rows[m.focusRow].tiles.Count() - 1
        if m.focusCol > lastCol then m.focusCol = lastCol
        if m.focusCol < 0 then m.focusCol = 0
    end if
    applyHighlight()
end sub

sub layoutNormal(favs as Object, inputs as Object)
    m.appsTitle.visible = true
    m.appsTitle.translation = [120, 330]
    m.appsArea.translation = [0, 395]
    if favs.Count() = 0
        m.emptyLabel.translation = [120, 410]
        m.emptyLabel.visible = true
    else
        m.emptyLabel.visible = false
        m.rows.Push(makeRow(m.appsArea, favs, "app", 120, 0, 290, 218, 36, 30, true))
    end if

    if inputs.Count() > 0
        m.inputsTitle.visible = true
        m.inputsArea.visible = true
        m.rows.Push(makeRow(m.inputsArea, inputs, "input", 120, 0, 290, 140, 36, 0, true))
    else
        m.inputsTitle.visible = false
        m.inputsArea.visible = false
    end if
end sub

' simpleMode: favorites only, at most 6, big tiles in 2 rows of 3.
sub layoutSimple(favs as Object)
    m.appsTitle.visible = false
    m.inputsTitle.visible = false
    m.inputsArea.visible = false
    m.appsArea.translation = [0, 260]
    if favs.Count() = 0
        m.emptyLabel.translation = [120, 330]
        m.emptyLabel.visible = true
        return
    end if
    m.emptyLabel.visible = false

    firstRow = []
    secondRow = []
    for i = 0 to favs.Count() - 1
        if i < 3
            firstRow.Push(favs[i])
        else if i < 6
            secondRow.Push(favs[i])
        end if
    end for

    w = 400
    h = 300
    gap = 90
    m.rows.Push(makeRow(m.appsArea, firstRow, "app", centeredX(firstRow.Count(), w, gap), 0, w, h, gap, 48, false))
    if secondRow.Count() > 0
        m.rows.Push(makeRow(m.appsArea, secondRow, "app", centeredX(secondRow.Count(), w, gap), h + 95, w, h, gap, 48, false))
    end if
end sub

function centeredX(n as Integer, w as Integer, gap as Integer) as Integer
    total = n * w + (n - 1) * gap
    return Int((1920 - total) / 2)
end function

function makeRow(area as Object, items as Object, kind as String, x0 as Integer, y as Integer, w as Integer, h as Integer, gap as Integer, nameSize as Integer, scroll as Boolean) as Object
    group = area.createChild("Group")
    group.translation = [x0, y]
    tiles = []
    pitch = w + gap
    for i = 0 to items.Count() - 1
        it = items[i]
        tile = group.createChild("DetoxTile")
        tile.translation = [i * pitch, 0]
        tile.tileData = { kind: kind, name: it.name, icon: it.icon, port: it.port, w: w, h: h, nameSize: nameSize }
        tiles.Push(tile)
    end for
    visibleCount = Int((1920 - x0 - 60) / pitch)
    if visibleCount < 1 then visibleCount = 1
    return { group: group, items: items, tiles: tiles, x0: x0, y: y, pitch: pitch, start: 0, visibleCount: visibleCount, scroll: scroll }
end function

function cleanItems(list as Object) as Object
    out = []
    for each it in list
        if type(it) = "roAssociativeArray"
            id = asStr(it.id)
            if id <> ""
                name = asStr(it.name)
                if name = "" then name = id
                out.Push({ id: id, name: name, icon: asStr(it.icon), port: asStr(it.port) })
            end if
        end if
    end for
    return out
end function

sub clearChildren(node as Object)
    n = node.getChildCount()
    if n > 0 then node.removeChildrenIndex(n, 0)
end sub

sub applyHighlight()
    for r = 0 to m.rows.Count() - 1
        row = m.rows[r]
        for c = 0 to row.tiles.Count() - 1
            row.tiles[c].highlighted = (r = m.focusRow and c = m.focusCol)
        end for
    end for
    ensureVisible()
end sub

' Scrolls the focused row sideways so the focused tile is on screen.
sub ensureVisible()
    if m.rows.Count() = 0 then return
    row = m.rows[m.focusRow]
    if not row.scroll then return
    if m.focusCol < row.start then row.start = m.focusCol
    if m.focusCol > row.start + row.visibleCount - 1 then row.start = m.focusCol - row.visibleCount + 1
    row.group.translation = [row.x0 - row.start * row.pitch, row.y]
end sub

' ---------------------------------------------------------------- actions

sub launchItem(item as Object)
    if m.cfg = invalid then return
    showOverlay("Opening " + item.name + Chr(8230), "", 15)
    startRequest("launch", "POST", "/api/tv/launch", invalid, { id: item.id }, { name: item.name })
end sub

sub onLaunchResponse(resp as Object, info as Object)
    data = resp.data
    errText = ""
    if type(data) = "roAssociativeArray" then errText = asStr(data.error)
    if asBool(resp.ok) and errText = ""
        ' Roku closes this app when the other one opens; the overlay timer covers the gap.
        setBanner("")
        return
    end if
    if errText = "" and asInt(resp.code, 0) <= 0
        errText = "Can't reach Roku Detox on your Mac."
        setBanner(reachText(resp))
    else if errText = "" and (asInt(resp.code, 0) = 401 or asInt(resp.code, 0) = 403)
        errText = "Roku Detox on your Mac didn't accept this TV. Press Install on TV again."
        setBanner(reachText(resp))
    else if errText = ""
        errText = "Something went wrong. Try again in a moment."
    end if
    showOverlay("Couldn't open " + asStr(info.name), errText, 5)
end sub

sub openItem(contentId as String)
    if m.configMissing then return
    if m.cfg = invalid
        m.pendingLink = { contentId: contentId }
        return
    end if
    stopVideo()
    m.itemSeq = m.itemSeq + 1
    setMode("loading")
    startRequest("item", "GET", "/api/tv/item", { id: contentId }, invalid, { seq: m.itemSeq })
end sub

sub onItemResponse(resp as Object, info as Object)
    if asInt(info.seq, -1) <> m.itemSeq or m.mode <> "loading" then return
    data = resp.data
    if not asBool(resp.ok) or type(data) <> "roAssociativeArray"
        code = asInt(resp.code, 0)
        errText = ""
        if type(data) = "roAssociativeArray" then errText = asStr(data.error)
        if code <= 0 or code = 401 or code = 403
            setBanner(reachText(resp))
            goHome()
        else
            if errText = "" then errText = "Roku Detox on your Mac couldn't find it."
            showNotice("Couldn't open this", errText)
        end if
        return
    end if

    kind = LCase(asStr(data.kind))
    if kind = "video"
        showVideo(data)
    else if kind = "message"
        showMessage("", asStr(data.text), asStr(data.from))
    else if kind = "notice"
        showNotice(asStr(data.title), asStr(data.text))
    else
        goHome()
    end if
end sub

' ---------------------------------------------------------------- remote keys

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false

    if m.mode = "home"
        return handleHomeKey(key)
    else if m.mode = "message"
        if key = "OK" or key = "back" then goHome()
        return true
    else if m.mode = "video"
        ' Reaches here only when the Video node didn't use the key.
        if key = "back"
            goHome()
            return true
        end if
        return false
    else if m.mode = "loading"
        if key = "back"
            m.itemSeq = m.itemSeq + 1   ' ignore the answer when it arrives
            goHome()
        end if
        return true
    end if

    ' "setup": Back exits the app.
    return false
end function

function handleHomeKey(key as String) as Boolean
    if m.overlay.visible
        if key = "back" then hideOverlay()
        return true
    end if

    ' Back on Home: not handled, so the app exits normally.
    if key = "back" then return false
    if m.rows.Count() = 0 then return true

    row = m.rows[m.focusRow]
    if key = "left"
        if m.focusCol > 0
            m.focusCol = m.focusCol - 1
            applyHighlight()
        end if
    else if key = "right"
        if m.focusCol < row.tiles.Count() - 1
            m.focusCol = m.focusCol + 1
            applyHighlight()
        end if
    else if key = "up"
        if m.focusRow > 0 then moveToRow(m.focusRow - 1)
    else if key = "down"
        if m.focusRow < m.rows.Count() - 1 then moveToRow(m.focusRow + 1)
    else if key = "OK"
        if m.focusCol >= 0 and m.focusCol < row.items.Count() then launchItem(row.items[m.focusCol])
    end if
    return true
end function

' Moves to another row, keeping roughly the same spot on screen.
sub moveToRow(newRow as Integer)
    cur = m.rows[m.focusRow]
    target = m.rows[newRow]
    col = target.start + (m.focusCol - cur.start)
    lastCol = target.tiles.Count() - 1
    if col > lastCol then col = lastCol
    if col < 0 then col = 0
    m.focusRow = newRow
    m.focusCol = col
    applyHighlight()
end sub
