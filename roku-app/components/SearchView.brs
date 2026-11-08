' SearchView - asks what to search for, searches the user's sites (a few at a time), and shows one row per site.

sub init()
    m.heading = m.top.findNode("heading")
    m.statusLabel = m.top.findNode("statusLabel")
    m.hintLabel = m.top.findNode("hintLabel")
    m.list = m.top.findNode("list")
    m.noteGroup = m.top.findNode("noteGroup")
    m.noteTitle = m.top.findNode("noteTitle")
    m.noteText = m.top.findNode("noteText")
    m.noteLink = m.top.findNode("noteLink")
    m.list.observeField("rowItemSelected", "onResultChosen")
    m.sites = []
    m.query = ""
    m.seq = 0
    m.queue = []
    m.running = {}
    m.root = invalid
    m.rowCount = 0
    m.problems = []
    m.skippedApp = false
    m.dialog = invalid
    m.finder = invalid
    m.hintLabel.visible = false
end sub

sub onBegin()
    data = m.top.begin
    if type(data) <> "roAssociativeArray" then return
    m.sites = asArray(data.sites)
    hideNote()
    query = asStr(data.query)
    query = query.Trim()
    if query <> ""
        startSearch(query)
    else
        clearResults()
        m.heading.text = "Search my sites"
        m.statusLabel.text = ""
        askForWords("")
    end if
end sub

sub onTakeFocus()
    giveFocus()
end sub

sub giveFocus()
    if m.dialog <> invalid then return
    if m.rowCount > 0 and not m.noteGroup.visible
        m.list.setFocus(true)
    else
        m.top.setFocus(true)
    end if
end sub

' ---------------------------------------------------------------- the keyboard

sub askForWords(startWith as String)
    dialog = CreateObject("roSGNode", "StandardKeyboardDialog")
    if dialog = invalid
        showNote("Can't search on this TV", "This Roku is too old for the keyboard this needs.", "")
        return
    end if
    dialog.title = "Search my sites"
    dialog.message = ["What do you want to watch?"]
    dialog.buttons = ["Search", "Cancel"]
    dialog.text = startWith
    dialog.observeField("buttonSelected", "onKeyboardButton")
    dialog.observeField("wasClosed", "onKeyboardClosed")
    m.dialog = dialog
    m.top.getScene().dialog = dialog
end sub

sub onKeyboardButton()
    if m.dialog = invalid then return
    chosen = m.dialog.buttonSelected
    words = asStr(m.dialog.text)
    words = words.Trim()
    closeKeyboard()
    if chosen = 0 and words <> ""
        startSearch(words)
    else
        afterKeyboard()
    end if
end sub

sub onKeyboardClosed()
    if m.dialog = invalid then return
    m.dialog = invalid
    afterKeyboard()
end sub

sub closeKeyboard()
    m.dialog.unobserveField("buttonSelected")
    m.dialog.unobserveField("wasClosed")
    m.dialog.close = true
    m.dialog = invalid
end sub

' Cancelled: back to the results, or away if there aren't any.
sub afterKeyboard()
    if m.rowCount = 0 and m.query = ""
        m.top.closed = true
    else
        giveFocus()
    end if
end sub

' ---------------------------------------------------------------- searching

sub clearResults()
    m.seq = m.seq + 1
    m.query = ""
    m.queue = []
    m.running = {}
    m.rowCount = 0
    m.problems = []
    m.skippedApp = false
    m.root = CreateObject("roSGNode", "ContentNode")
    m.list.content = m.root
    m.hintLabel.visible = false
end sub

sub startSearch(words as String)
    clearResults()
    m.query = words
    m.heading.text = Chr(8220) + words + Chr(8221)
    for i = 0 to m.sites.Count() - 1
        site = m.sites[i]
        if isYouTubeSearch(asStr(site.search))
            m.skippedApp = true
        else
            m.queue.Push({ site: site, order: i })
        end if
    end for
    m.top.searched = words
    m.top.setFocus(true)
    if m.queue.Count() = 0
        finishSearch()
        return
    end if
    m.statusLabel.text = "Searching your sites" + Chr(8230)
    startMore()
end sub

' YouTube results can only open in the YouTube app, which apps on the TV can't start.
function isYouTubeSearch(search as String) as Boolean
    host = ssUrlParts(search).host
    if Left(host, 4) = "www." then host = Mid(host, 5)
    if Left(host, 2) = "m." then host = Mid(host, 3)
    return ssState().youtubeHosts.DoesExist(host)
end function

sub startMore()
    while m.running.Count() < 3 and m.queue.Count() > 0
        job = m.queue.Shift()
        task = CreateObject("roSGNode", "SiteSearchTask")
        task.id = "ss" + m.seq.ToStr() + "-" + job.order.ToStr()
        task.request = { site: job.site, query: m.query, order: job.order, slot: task.id }
        task.observeField("response", "onSiteResponse")
        m.running[task.id] = task
        task.control = "RUN"
    end while
end sub

sub onSiteResponse(event as Object)
    task = event.getRoSGNode()
    if task = invalid then return
    task.unobserveField("response")
    prefix = "ss" + m.seq.ToStr() + "-"
    if Left(task.id, Len(prefix)) <> prefix then return    ' from an earlier search
    m.running.Delete(task.id)
    data = event.getData()
    if type(data) = "roAssociativeArray"
        results = asArray(data.results)
        if results.Count() > 0
            addRow(asStr(data.site), results)
        else if asStr(data.error) <> ""
            m.problems.Push(asStr(data.site))
        end if
    end if
    if m.running.Count() = 0 and m.queue.Count() = 0
        finishSearch()
    else
        startMore()
    end if
end sub

sub addRow(siteName as String, results as Object)
    row = m.root.createChild("ContentNode")
    row.title = siteName
    for each result in results
        item = row.createChild("ContentNode")
        item.title = asStr(result.title)
        item.url = asStr(result.url)
        item.hdposterurl = asStr(result.image)
        item.description = asStr(result.app)
    end for
    m.rowCount = m.rowCount + 1
    if m.rowCount = 1
        m.hintLabel.visible = true
        giveFocus()
    end if
end sub

sub finishSearch()
    notes = []
    if m.rowCount = 0 and m.queue.Count() = 0
        if m.sites.Count() = 0 or (m.skippedApp and m.problems.Count() = 0 and m.sites.Count() = 1)
            notes.Push("There's nothing here this can search yet.")
        else
            notes.Push("Nothing found.")
        end if
    end if
    if m.problems.Count() > 0 then notes.Push("Couldn't read " + ssJoin(m.problems, ", ") + ".")
    if m.skippedApp then notes.Push("YouTube isn't searched here: its videos only open in the YouTube app.")
    m.statusLabel.text = ssJoin(notes, " ")
    if m.rowCount = 0
        m.hintLabel.text = "Press * to search again. Back to leave."
        m.hintLabel.visible = true
        giveFocus()
    else
        m.hintLabel.text = "OK plays it. Press * to search again. Back to leave."
    end if
end sub

' ---------------------------------------------------------------- playing a result

sub onResultChosen()
    if m.finder <> invalid or m.root = invalid then return
    chosen = m.list.rowItemSelected
    if type(chosen) <> "roArray" then return
    row = m.root.getChild(chosen[0])
    if row = invalid then return
    item = row.getChild(chosen[1])
    if item = invalid then return
    app = asStr(item.description)
    if app <> ""
        showNote("Opens in the " + app + " app", "Apps on the TV can't open other apps. Find this one from the Roku home screen.", item.url)
        return
    end if
    m.statusLabel.text = "Finding the video" + Chr(8230)
    m.chosenLink = item.url
    task = CreateObject("roSGNode", "FindVideoTask")
    task.request = { url: item.url, title: item.title, slot: "find" }
    task.observeField("response", "onVideoFound")
    m.finder = task
    task.control = "RUN"
end sub

sub onVideoFound(event as Object)
    if m.finder = invalid then return
    m.finder.unobserveField("response")
    m.finder = invalid
    m.statusLabel.text = ""
    data = event.getData()
    if type(data) <> "roAssociativeArray" then return
    if asStr(data.url) <> ""
        m.top.playItem = data
    else
        showNote("Couldn't play this one", asStr(data.error), m.chosenLink)
    end if
end sub

' ---------------------------------------------------------------- notes and keys

sub showNote(title as String, text as String, link as String)
    m.noteTitle.text = title
    m.noteText.text = text
    m.noteLink.text = link
    m.noteGroup.visible = true
    m.top.setFocus(true)
end sub

sub hideNote()
    m.noteGroup.visible = false
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if m.noteGroup.visible
        if key = "OK" or key = "back"
            hideNote()
            giveFocus()
        end if
        return true
    end if
    if key = "options"
        askForWords(m.query)
        return true
    end if
    if key = "back"
        clearResults()
        m.top.closed = true
        return true
    end if
    return false
end function
