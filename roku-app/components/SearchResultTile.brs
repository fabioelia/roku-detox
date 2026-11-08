' SearchResultTile - draws one result. itemContent: title, hdposterurl, description (an app name if it only opens there).

sub onContent()
    item = m.top.itemContent
    if item = invalid then return
    m.top.findNode("titleLabel").text = item.title
    m.top.findNode("poster").uri = item.hdposterurl
    note = asStr(item.description)
    if note <> "" then note = note + " app only"
    m.top.findNode("noteLabel").text = note
end sub
