' DetoxTile - an app tile (icon + name under it) or an input tile (name + port inside a box).

sub init()
    m.outline = m.top.findNode("outline")
    m.boxRect = m.top.findNode("boxRect")
    m.boxTitle = m.top.findNode("boxTitle")
    m.boxSub = m.top.findNode("boxSub")
    m.poster = m.top.findNode("poster")
    m.nameLabel = m.top.findNode("nameLabel")
    m.kind = "app"
    m.poster.observeField("loadStatus", "onPosterStatus")
end sub

sub onTileDataChanged()
    d = m.top.tileData
    if type(d) <> "roAssociativeArray" then return

    m.kind = asStr(d.kind)
    w = asInt(d.w, 290)
    h = asInt(d.h, 218)
    nameSize = asInt(d.nameSize, 30)
    name = asStr(d.name)
    border = 8

    m.outline.translation = [-border, -border]
    m.outline.width = w + border * 2
    m.outline.height = h + border * 2
    m.boxRect.width = w
    m.boxRect.height = h

    if m.kind = "input"
        ' Text tile: name, port under it, both inside the box.
        m.poster.visible = false
        m.nameLabel.visible = false
        titleH = Int(h * 0.58)
        m.boxTitle.translation = [16, 0]
        m.boxTitle.width = w - 32
        m.boxTitle.height = titleH
        m.boxTitle.vertAlign = "bottom"
        m.boxTitle.maxLines = 2
        setFont(m.boxTitle, 34, true)
        m.boxTitle.text = name
        m.boxTitle.visible = true

        m.boxSub.translation = [16, titleH + 8]
        m.boxSub.width = w - 32
        setFont(m.boxSub, 26, false)
        m.boxSub.text = asStr(d.port)
        m.boxSub.visible = true
    else
        ' App tile: poster fills the box; the app name sits under it.
        m.boxSub.visible = false
        m.boxTitle.translation = [16, 0]
        m.boxTitle.width = w - 32
        m.boxTitle.height = h
        m.boxTitle.vertAlign = "center"
        m.boxTitle.maxLines = 3
        setFont(m.boxTitle, Int(nameSize * 1.1), true)
        m.boxTitle.text = name
        m.boxTitle.visible = true   ' placeholder until the icon loads (or if it fails)

        m.poster.translation = [0, 0]
        m.poster.width = w
        m.poster.height = h
        icon = asStr(d.icon)
        if icon <> ""
            m.poster.uri = icon
            m.poster.visible = true
        else
            m.poster.visible = false
        end if

        m.nameLabel.translation = [0, h + 14]
        m.nameLabel.width = w
        setFont(m.nameLabel, nameSize, false)
        m.nameLabel.text = name
        m.nameLabel.visible = true
    end if

    onHighlightChanged()
end sub

sub onPosterStatus()
    if m.kind = "input" then return
    m.boxTitle.visible = (m.poster.loadStatus <> "ready")
end sub

sub onHighlightChanged()
    if m.outline = invalid then return
    isOn = m.top.highlighted
    m.outline.visible = isOn
    if isOn
        m.boxRect.color = "0x2A3646FF"
        m.nameLabel.color = "0xFFFFFFFF"
        m.boxTitle.color = "0xFFFFFFFF"
        m.boxSub.color = "0xC9D3DDFF"
    else
        m.boxRect.color = "0x1B2430FF"
        m.nameLabel.color = "0x8D9AA8FF"
        m.boxTitle.color = "0xD5DEE7FF"
        m.boxSub.color = "0x8D9AA8FF"
    end if
end sub
