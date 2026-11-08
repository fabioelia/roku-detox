' HomeScene - Detox Home's screens: the home screen, and message / notice / video screens.
'
' Needs no computer. The apps, their icons and opening them all go through this TV's own
' remote-control service (EcpTask). Favorites and options are kept on the TV (registry section
' "DetoxHome"). Roku Detox on a computer or phone only ever sends things in: deep links and
' ECP input events (see onDeepLink).
'
' Modes: "home" | "message" (also notices) | "video" | "search"

sub init()
    ' Text sizes (see setFont in DetoxUtils.brs).
    applyFonts([["clockLabel", 120, true], ["dateLabel", 40, false], ["tvNameLabel", 32, false], ["hintLabel", 26, false], ["statusLabel", 40, false], ["emptyLabel", 40, false], ["bannerLabel", 28, false], ["overlayTitle", 72, true], ["overlayText", 40, false]])
    m.top.backgroundURI = ""
    m.top.backgroundColor = "0x10161FFF"

    m.homeGroup = m.top.findNode("homeGroup")
    m.rowsArea = m.top.findNode("rowsArea")
    m.topCover = m.top.findNode("topCover")
    m.clockLabel = m.top.findNode("clockLabel")
    m.dateLabel = m.top.findNode("dateLabel")
    m.tvNameLabel = m.top.findNode("tvNameLabel")
    m.hintLabel = m.top.findNode("hintLabel")
    m.statusLabel = m.top.findNode("statusLabel")
    m.emptyLabel = m.top.findNode("emptyLabel")
    m.banner = m.top.findNode("banner")
    m.bannerLabel = m.top.findNode("bannerLabel")
    m.messageView = m.top.findNode("messageView")
    m.videoView = m.top.findNode("videoView")
    m.searchView = m.top.findNode("searchView")
    m.overlay = m.top.findNode("overlay")
    m.overlayTitle = m.top.findNode("overlayTitle")
    m.overlayText = m.top.findNode("overlayText")
    m.clockTimer = m.top.findNode("clockTimer")
    m.refreshTimer = m.top.findNode("refreshTimer")
    m.overlayTimer = m.top.findNode("overlayTimer")
    m.bannerTimer = m.top.findNode("bannerTimer")

    m.reg = CreateObject("roRegistrySection", "DetoxHome")
    m.idPattern = CreateObject("roRegex", "^[A-Za-z0-9._-]{1,64}$", "")
    m.favorites = loadFavorites()      ' [app id], in the order they were added
    m.clock24 = (m.reg.Read("clock24") = "1")
    m.simple = (m.reg.Read("simpleMode") = "1")
    m.tvName = m.reg.Read("tvName")
    m.sites = loadSites()      ' [{id, name, search, p}]: the sites to search, sent by Roku Detox
    m.recent = loadRecent()    ' the last searches, newest first
    m.sitesParts = invalid     ' a list of sites arriving in pieces: {rev, parts}
    m.fromSearch = false       ' a video or note opened from the search screen goes back there

    m.ecpHost = ""             ' the TV's own address that answered last
    m.apps = invalid           ' [{id, name, kind: "app"|"input", port}] from query/apps
    m.appsSig = ""             ' FormatJson of it, to skip rebuilding when nothing changed
    m.appsInFlight = false
    m.appsProblem = ""
    m.mode = "home"
    m.rows = []                ' [{kind, group, items, tiles, x0, y, top, height, pitch, start, visibleCount, scroll, vscroll, titleLabel}]
    m.rowsBaseY = 330
    m.scrollY = 0
    m.focusRow = 0
    m.focusCol = 0
    m.tasks = {}               ' in-flight EcpTask nodes by id
    m.taskSeq = 0

    m.clockTimer.observeField("fire", "updateClock")
    m.refreshTimer.observeField("fire", "onRefreshTimer")
    m.overlayTimer.observeField("fire", "hideOverlay")
    m.bannerTimer.observeField("fire", "hideBanner")
    m.videoView.observeField("finished", "onVideoFinished")
    m.videoView.observeField("playbackError", "onVideoError")
    m.searchView.observeField("closed", "onSearchClosed")
    m.searchView.observeField("playItem", "onSearchPlay")
    m.searchView.observeField("searched", "onSearched")

    m.tvNameLabel.text = m.tvName
    setClockLayout(m.simple)
    updateClock()
    m.clockTimer.control = "start"
    m.refreshTimer.control = "start"
    fetchApps()
    startEcp("device", "GET", "query/device-info", {})
    buildHome()
    m.top.setFocus(true)
end sub

' ---------------------------------------------------------------- what's kept on the TV

function loadSites() as Object
    return cleanSites(ParseJson(m.reg.Read("sites")))
end function

function loadRecent() as Object
    out = []
    list = ParseJson(m.reg.Read("recentSearches"))
    if type(list) = "roArray"
        for each v in list
            if asStr(v) <> "" and out.Count() < 8 then out.Push(asStr(v))
        end for
    end if
    return out
end function

' Sites as sent: [[id, name, search address, 1 if added from a phone], ...] (or already cleaned).
function cleanSites(list as Dynamic) as Object
    out = []
    if type(list) <> "roArray" then return out
    for each v in list
        site = invalid
        if type(v) = "roArray"
            if v.Count() >= 3 then site = { id: asStr(v[0]), name: asStr(v[1]), search: asStr(v[2]), p: (v.Count() > 3) }
        else if type(v) = "roAssociativeArray"
            site = { id: asStr(v.id), name: asStr(v.name), search: asStr(v.search), p: asBool(v.p) }
        end if
        if site <> invalid
            if site.name <> "" and Left(LCase(site.search), 4) = "http" and out.Count() < 20 then out.Push(site)
        end if
    end for
    return out
end function

sub saveSites(list as Object, rev as String)
    m.sites = list
    m.reg.Write("sites", FormatJson(list))
    m.reg.Write("sitesRev", rev)
    m.reg.Flush()
end sub

function loadFavorites() as Object
    return cleanIds(ParseJson(m.reg.Read("favorites")))
end function

sub saveFavorites(list as Object)
    m.favorites = list
    m.reg.Write("favorites", FormatJson(list))
    m.reg.Flush()
end sub

sub saveFlag(key as String, isOn as Boolean)
    value = "0"
    if isOn then value = "1"
    m.reg.Write(key, value)
    m.reg.Flush()
end sub

' App ids from JSON or a deep link: strings like "12" or "tvinput.hdmi1", no repeats.
function cleanIds(list as Dynamic) as Object
    out = []
    if type(list) <> "roArray" then return out
    for each v in list
        id = asStr(v)
        id = id.Trim()
        if id <> ""
            if m.idPattern.IsMatch(id) and not hasValue(out, id) then out.Push(id)
        end if
    end for
    return out
end function

' "1" / "0" (or true / false) from a deep link; invalid when it isn't there.
function flagFrom(v as Dynamic) as Dynamic
    t = type(v)
    if t = "Boolean" or t = "roBoolean" then return v
    s = LCase(asStr(v))
    if s = "1" or s = "true" then return true
    if s = "0" or s = "false" then return false
    return invalid
end function

' ---------------------------------------------------------------- fields from main.brs

' A fresh install from Roku Detox on a computer brings its favorites and options. They're used
' once per install (the "seed" id); after that the TV's own choices win.
sub onSeed()
    seed = m.top.seed
    if type(seed) <> "roAssociativeArray" then return
    seedId = asStr(seed.seed)
    if seedId = "" or seedId = m.reg.Read("seedId") then return
    if type(seed.favorites) = "roArray" then saveFavorites(cleanIds(seed.favorites))
    if type(seed.sites) = "roArray" then saveSites(cleanSites(seed.sites), "")
    saveFlag("clock24", asBool(seed.clock24))
    saveFlag("simpleMode", asBool(seed.simpleMode))
    if asStr(seed.tvName) <> "" and m.tvName = ""
        m.tvName = asStr(seed.tvName)
        m.tvNameLabel.text = m.tvName
        m.reg.Write("tvName", m.tvName)
    end if
    m.reg.Write("seedId", seedId)
    m.reg.Flush()
    m.clock24 = asBool(seed.clock24)
    m.simple = asBool(seed.simpleMode)
    applyLook()
end sub

' Deep links (launch/dev?...) and ECP input events (input?...) from Roku Detox:
'   contentId=inline     mediaType=video|message|notice, with url, title, text, from, streamFormat, referer
'   contentId=favorites  ids=12,837,tvinput.hdmi1 (empty clears them)
'   contentId=settings   clock24=0|1, simpleMode=0|1 (either one)
'   contentId=sites      rev, part, of, data: the sites to search, as JSON, in one or more pieces
' Anything else (like an item id from an older Roku Detox) shows the home screen.
sub onDeepLink()
    link = m.top.deepLink
    if type(link) <> "roAssociativeArray" then return
    contentId = LCase(asStr(link.contentId))
    if contentId = "inline"
        showInline(link)
    else if contentId = "favorites"
        ids = asStr(link.ids)
        saveFavorites(cleanIds(ids.Split(",")))
        buildHome()
    else if contentId = "settings"
        clock24 = flagFrom(link.clock24)
        if clock24 <> invalid
            m.clock24 = clock24
            saveFlag("clock24", clock24)
        end if
        simple = flagFrom(link.simpleMode)
        if simple <> invalid
            m.simple = simple
            saveFlag("simpleMode", simple)
        end if
        applyLook()
    else if contentId = "sites"
        receiveSites(link)
    else
        if m.mode <> "home" then goHome()   ' anything else (like an older Roku Detox's item id): the home screen
    end if
end sub

' One piece of the list of sites. The list is used when all its pieces are here; a newer list replaces it.
sub receiveSites(link as Object)
    rev = asStr(link.rev)
    part = Int(Val(asStr(link.part)))
    total = Int(Val(asStr(link.of)))
    if rev = "" or part < 1 or total < 1 or part > total or total > 40 then return
    if rev = m.reg.Read("sitesRev") then return    ' already have this list
    if m.sitesParts = invalid then m.sitesParts = { rev: "", parts: {} }
    if m.sitesParts.rev <> rev then m.sitesParts = { rev: rev, parts: {} }
    m.sitesParts.parts[part.ToStr()] = asStr(link.data)
    if m.sitesParts.parts.Count() < total then return
    text = ""
    for i = 1 to total
        piece = m.sitesParts.parts[i.ToStr()]
        if piece = invalid then return
        text = text + piece
    end for
    m.sitesParts = invalid
    list = ParseJson(text)
    if type(list) <> "roArray" then return
    saveSites(cleanSites(list), rev)
    if m.mode = "home" then buildHome()
end sub

' An item carried in the deep link itself: {mediaType, url, title, text, from, ...}.
sub showInline(link as Object)
    m.fromSearch = false
    kind = LCase(asStr(link.mediaType))
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
        m.topCover.height = 250
    else
        setFont(m.clockLabel, 120, true)
        m.clockLabel.translation = [120, 60]
        setFont(m.dateLabel, 40, false)
        m.dateLabel.translation = [124, 210]
        m.topCover.height = 320
    end if
end sub

sub updateClock()
    dt = localNow()
    m.clockLabel.text = formatTime(dt, m.clock24)
    m.dateLabel.text = formatDate(dt)
end sub

' After the 12/24-hour clock or simple mode changed.
sub applyLook()
    setClockLayout(m.simple)
    updateClock()
    buildHome()
end sub

' ---------------------------------------------------------------- modes

sub setMode(mode as String)
    m.mode = mode
    m.homeGroup.visible = (mode = "home")
    m.messageView.visible = (mode = "message")
    m.videoView.visible = (mode = "video")
    m.searchView.visible = (mode = "search")
    if mode <> "home"
        hideOverlay()
        hideBanner()
    end if
    ' The Video node takes focus itself (for trickplay); everything else is handled here.
    if mode = "search"
        m.searchView.takeFocus = true
    else if mode <> "video"
        m.top.setFocus(true)
    end if
end sub

sub goHome()
    m.fromSearch = false
    stopVideo()
    setMode("home")
    applyHighlight()
end sub

' Done with a video or a note: back to the search it came from, or home.
sub leaveItem()
    if m.fromSearch
        stopVideo()
        setMode("search")
    else
        goHome()
    end if
end sub

' ---------------------------------------------------------------- searching my sites

sub openSearch(query as String)
    m.fromSearch = true
    setMode("search")
    m.searchView.begin = { sites: m.sites, query: query }
end sub

sub onSearchClosed()
    if m.mode = "search" then goHome()
end sub

sub onSearchPlay()
    m.fromSearch = true
    showVideo(m.searchView.playItem)
end sub

' Newest first, no repeats, the last 8.
sub onSearched()
    words = asStr(m.searchView.searched)
    if words = "" then return
    list = [words]
    for each v in m.recent
        if LCase(v) <> LCase(words) and list.Count() < 8 then list.Push(v)
    end for
    m.recent = list
    m.reg.Write("recentSearches", FormatJson(list))
    m.reg.Flush()
    buildHome()
end sub

function searchTiles() as Object
    tiles = [{ id: "search", kind: "input", action: "search", name: "Search", port: "Type what to find" }]
    for each words in m.recent
        tiles.Push({ id: "recent", kind: "input", action: "recent", name: words, port: "Search again" })
    end for
    return tiles
end function

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
    if m.mode = "video" then leaveItem()
end sub

sub onVideoError()
    if m.mode <> "video" then return
    errText = asStr(m.videoView.playbackError)
    showNotice("Couldn't play this video", errText)
end sub

' ---------------------------------------------------------------- banner + overlay

sub showBanner(text as String)
    if m.mode <> "home" then return
    m.bannerLabel.text = text
    m.banner.visible = true
    m.bannerTimer.control = "stop"
    m.bannerTimer.control = "start"
end sub

sub hideBanner()
    m.banner.visible = false
    m.bannerTimer.control = "stop"
end sub

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

' Roku OS 12 and later refuse remote-control requests from apps on the TV itself, whatever the "Control by
' mobile apps" setting says (Roku's ECP docs: support for sending ECP commands from within a Roku app has
' been discontinued). So Detox Home can't list or open apps there; its clock, messages and videos still work.
function blockedText() as String
    ' Roku OS 12 and later refuse apps on the TV whatever the setting; before that, the setting decides.
    major = 0
    v = CreateObject("roDeviceInfo").GetOSVersion()
    if type(v) = "roAssociativeArray" then major = Val(asStr(v.major))
    if major > 0 and major < 12
        return "Roku is blocking requests from apps. On this TV, open Settings, System, Advanced system settings, Control by mobile apps, Network access, and choose Default or Permissive."
    end if
    return "This Roku doesn't let apps on the TV open other apps (a Roku rule since Roku OS 12), so your apps can't show here. The clock, messages and videos still work. Open apps from the Roku home screen, or with Roku Detox on your phone or computer."
end function

' ---------------------------------------------------------------- talking to this TV

' Starts one EcpTask. extra is kept and handed back with the response.
sub startEcp(tag as String, method as String, path as String, extra as Object)
    m.taskSeq = m.taskSeq + 1
    key = "ecp" + m.taskSeq.ToStr()
    task = CreateObject("roSGNode", "EcpTask")
    task.id = key
    task.request = { tag: tag, method: method, path: path, host: m.ecpHost }
    task.observeField("response", "onEcpResponse")
    extra.tag = tag
    extra.node = task          ' keeps the task alive until it answers
    m.tasks[key] = extra
    task.control = "RUN"
end sub

sub onEcpResponse(event as Object)
    task = event.getRoSGNode()
    if task = invalid then return
    key = task.id
    task.unobserveField("response")
    info = m.tasks[key]
    if info = invalid then return
    m.tasks.Delete(key)

    resp = event.getData()
    if type(resp) <> "roAssociativeArray" then resp = { ok: false, code: 0, error: "no response" }
    ' Keep the last address that answered (the task tries it first, then looks again), so one
    ' failed request doesn't blank every icon.
    if asInt(resp.code, 0) > 0 and asStr(resp.host) <> "" then m.ecpHost = asStr(resp.host)

    if info.tag = "apps"
        onAppsResponse(resp)
    else if info.tag = "device"
        onDeviceResponse(resp)
    else if info.tag = "launch"
        onLaunchResponse(resp, info)
    end if
end sub

sub fetchApps()
    if m.appsInFlight then return
    m.appsInFlight = true
    startEcp("apps", "GET", "query/apps", {})
end sub

sub onRefreshTimer()
    ' Every 60 s: pick up apps added or removed on the TV, or try again after a problem.
    fetchApps()
end sub

sub onAppsResponse(resp as Object)
    m.appsInFlight = false
    code = asInt(resp.code, 0)
    if asBool(resp.ok) and type(resp.apps) = "roArray"
        m.appsProblem = ""
        sig = m.ecpHost + FormatJson(resp.apps)   ' a new address rebuilds too (icons use it)
        if sig <> m.appsSig or m.apps = invalid
            m.appsSig = sig
            m.apps = resp.apps
            buildHome()
        end if
        return
    end if
    if m.apps <> invalid then return   ' keep showing the apps from last time
    if code = 401 or code = 403
        m.appsProblem = blockedText()
    else if code > 0
        m.appsProblem = "The TV wouldn't list its apps (error " + code.ToStr() + "). Trying again in a minute."
    else
        m.appsProblem = "Couldn't ask the TV for its apps. Trying again in a minute. If this keeps happening, check Settings, System, Advanced system settings, Control by mobile apps."
    end if
    m.statusLabel.text = m.appsProblem
    m.statusLabel.visible = true
end sub

sub onDeviceResponse(resp as Object)
    name = asStr(resp.name)
    if not asBool(resp.ok) or name = "" then return
    if name <> m.tvName
        m.tvName = name
        m.reg.Write("tvName", name)
        m.reg.Flush()
    end if
    m.tvNameLabel.text = name
end sub

' ---------------------------------------------------------------- home layout

sub buildHome()
    ' Remember which row the focus was in, to land in the same one after rebuilding.
    oldKind = ""
    if m.rows.Count() > 0 and m.focusRow < m.rows.Count() then oldKind = m.rows[m.focusRow].kind
    oldCol = m.focusCol

    clearChildren(m.rowsArea)
    m.rows = []
    m.scrollY = 0

    ' Apps are missing while loading, and always on Roku OS 12 and later (the status line says why).
    favs = []
    others = []
    inputs = []
    if m.apps <> invalid
        m.statusLabel.visible = false
        byId = {}
        for each a in m.apps
            byId[a.id] = a
        end for
        for each id in m.favorites
            if byId.DoesExist(id) then favs.Push(byId[id])
        end for
        for each a in m.apps
            if not hasValue(m.favorites, a.id)
                if a.kind = "input"
                    inputs.Push(a)
                else
                    others.Push(a)
                end if
            end if
        end for
    end if

    if m.simple and favs.Count() > 0
        layoutSimple(favs)
        m.hintLabel.text = "Press * on a tile to take it off your favorites"
    else
        m.rowsBaseY = 330
        y = 0
        if m.sites.Count() > 0 then y = addRow("search", "Search my sites", searchTiles(), y)
        if favs.Count() > 0 then y = addRow("favorites", "Favorites", favs, y)
        if others.Count() > 0
            title = "All apps"
            if favs.Count() = 0 then title = "Your apps"
            y = addRow("apps", title, others, y)
        end if
        if inputs.Count() > 0 then y = addRow("inputs", "Inputs", inputs, y)
        m.hintLabel.text = "Press * on a tile to add or remove a favorite"
        ' The note about apps sits under the search row when there is one.
        statusY = 410
        if y > 0 then statusY = m.rowsBaseY + y + 10
        m.statusLabel.translation = [120, statusY]
    end if
    m.rowsArea.translation = [0, m.rowsBaseY]
    m.emptyLabel.visible = (m.apps <> invalid and m.rows.Count() = 0)
    m.hintLabel.visible = (m.apps <> invalid and m.rows.Count() > 0)

    ' Back to the same row (or the first one) and roughly the same spot in it.
    m.focusRow = 0
    for r = 0 to m.rows.Count() - 1
        if m.rows[r].kind = oldKind then m.focusRow = r
    end for
    m.focusCol = oldCol
    if m.rows.Count() > 0
        lastCol = m.rows[m.focusRow].tiles.Count() - 1
        if m.focusCol > lastCol then m.focusCol = lastCol
    end if
    if m.focusCol < 0 then m.focusCol = 0
    applyHighlight()
end sub

' A titled row of tiles at height y in rowsArea. Returns where the next row starts.
function addRow(kind as String, title as String, items as Object, y as Integer) as Integer
    label = m.rowsArea.createChild("Label")
    label.translation = [120, y]
    label.color = "0xC9D3DDFF"
    setFont(label, 36, true)
    label.text = title
    h = 218
    nameSize = 30
    height = 65 + h + 60       ' title, tiles, names under them
    if kind = "inputs" or kind = "search"
        h = 140
        height = 65 + h + 30
    end if
    row = makeRow(m.rowsArea, items, kind, 120, y + 65, 290, h, 36, nameSize, true)
    row.top = y
    row.height = height
    row.vscroll = true
    row.titleLabel = label
    m.rows.Push(row)
    return y + height + 10
end function

' simpleMode: favorites only, at most 6, big tiles in 2 rows of 3.
sub layoutSimple(favs as Object)
    m.rowsBaseY = 260
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
    m.rows.Push(makeRow(m.rowsArea, firstRow, "simple1", centeredX(firstRow.Count(), w, gap), 0, w, h, gap, 48, false))
    if secondRow.Count() > 0
        m.rows.Push(makeRow(m.rowsArea, secondRow, "simple2", centeredX(secondRow.Count(), w, gap), h + 95, w, h, gap, 48, false))
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
        tile.tileData = { kind: it.kind, name: it.name, icon: iconUrl(it), port: it.port, w: w, h: h, nameSize: nameSize }
        tiles.Push(tile)
    end for
    visibleCount = Int((1920 - x0 - 60) / pitch)
    if visibleCount < 1 then visibleCount = 1
    return { kind: kind, group: group, items: items, tiles: tiles, x0: x0, y: y, top: 0, height: 0, pitch: pitch, start: 0, visibleCount: visibleCount, scroll: scroll, vscroll: false, titleLabel: invalid }
end function

' The TV serves each app's icon itself.
function iconUrl(item as Object) as String
    if item.kind = "input" or m.ecpHost = "" then return ""
    return "http://" + m.ecpHost + ":8060/query/icon/" + item.id
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

' Scrolls so the focused tile is on screen: its row sideways, and the rows up or down.
sub ensureVisible()
    if m.rows.Count() = 0 then return
    row = m.rows[m.focusRow]
    if row.scroll
        if m.focusCol < row.start then row.start = m.focusCol
        if m.focusCol > row.start + row.visibleCount - 1 then row.start = m.focusCol - row.visibleCount + 1
        row.group.translation = [row.x0 - row.start * row.pitch, row.y]
    end if
    if row.vscroll
        viewH = 1080 - m.rowsBaseY - 30
        if row.top < m.scrollY then m.scrollY = row.top
        if row.top + row.height > m.scrollY + viewH then m.scrollY = row.top + row.height - viewH
        if m.scrollY < 0 then m.scrollY = 0
        m.rowsArea.translation = [0, m.rowsBaseY - m.scrollY]
        ' Rows scrolled up out of view are hidden whole, not left half under the clock.
        for each r in m.rows
            shown = (r.top >= m.scrollY)
            r.group.visible = shown
            if r.titleLabel <> invalid then r.titleLabel.visible = shown
        end for
    end if
end sub

' ---------------------------------------------------------------- actions

sub launchItem(item as Object)
    if asStr(item.action) = "search"
        openSearch("")
        return
    else if asStr(item.action) = "recent"
        openSearch(item.name)
        return
    end if
    showOverlay("Opening " + item.name + Chr(8230), "", 15)
    startEcp("launch", "POST", "launch/" + item.id, { name: item.name })
end sub

sub onLaunchResponse(resp as Object, info as Object)
    ' On success Roku closes this app when the other one opens; the overlay covers the gap.
    if asBool(resp.ok) then return
    if m.mode <> "home" then return   ' a message or video came in meanwhile: don't cover it
    code = asInt(resp.code, 0)
    if code = 401 or code = 403
        errText = blockedText()
    else if code > 0
        errText = "The TV said no (error " + code.ToStr() + "). Try again, or open it from the Roku home screen."
    else
        errText = "Couldn't reach this TV's remote control service. Try again in a moment. If this keeps happening, check Settings, System, Advanced system settings, Control by mobile apps."
    end if
    showOverlay("Couldn't open " + asStr(info.name), errText, 10)
end sub

' The * button: add the tile to favorites, or take it off.
sub toggleFavorite(item as Object)
    if asStr(item.action) <> "" then return    ' search tiles aren't apps
    list = []
    wasFavorite = false
    for each id in m.favorites
        if id = item.id
            wasFavorite = true
        else
            list.Push(id)
        end if
    end for
    if not wasFavorite then list.Push(item.id)
    saveFavorites(list)
    buildHome()
    ' Keep the highlight on the app just toggled (it may have moved rows), so * again undoes it.
    for r = 0 to m.rows.Count() - 1
        for c = 0 to m.rows[r].items.Count() - 1
            if m.rows[r].items[c].id = item.id
                m.focusRow = r
                m.focusCol = c
            end if
        end for
    end for
    applyHighlight()
    if wasFavorite
        showBanner("Took " + item.name + " off favorites")
    else
        showBanner("Added " + item.name + " to favorites")
    end if
end sub

' ---------------------------------------------------------------- remote keys

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false

    if m.mode = "home"
        return handleHomeKey(key)
    else if m.mode = "message"
        if key = "OK" or key = "back" then leaveItem()
        return true
    else if m.mode = "video"
        ' Reaches here only when the Video node didn't use the key.
        if key = "back"
            leaveItem()
            return true
        end if
        return false
    else if m.mode = "search"
        return true    ' SearchView used what it wanted; Back must not leave the app from here
    end if
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
    else if key = "options"
        if m.focusCol >= 0 and m.focusCol < row.items.Count() then toggleFavorite(row.items[m.focusCol])
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
