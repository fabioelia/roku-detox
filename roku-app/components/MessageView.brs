' MessageView - very large text, "from" under it, "Press OK to close".
' With a title it doubles as the Notice screen ("Time's up" / "YouTube is done for today.").

sub init()
    ' Text sizes (see setFont in DetoxUtils.brs).
    applyFonts([["titleLabel", 64, true], ["bodyLabel", 80, true], ["fromLabel", 40, false], ["hintLabel", 32, false]])
    m.titleLabel = m.top.findNode("titleLabel")
    m.bodyLabel = m.top.findNode("bodyLabel")
    m.fromLabel = m.top.findNode("fromLabel")
end sub

sub onMessageChanged()
    msg = m.top.message
    if type(msg) <> "roAssociativeArray" then return
    title = asStr(msg.title)
    text = asStr(msg.text)
    sender = asStr(msg.from)

    if title <> ""
        m.titleLabel.text = title
        m.titleLabel.visible = true
        m.bodyLabel.translation = [160, 280]
        m.bodyLabel.height = 520
    else
        m.titleLabel.visible = false
        m.bodyLabel.translation = [160, 150]
        m.bodyLabel.height = 650
    end if

    ' Shrink the font only as much as the text needs.
    n = Len(text)
    size = 96
    if n > 40 then size = 80
    if n > 90 then size = 66
    if n > 170 then size = 54
    if n > 300 then size = 44
    setFont(m.bodyLabel, size, true)
    m.bodyLabel.text = text

    if sender <> ""
        m.fromLabel.text = Chr(8212) + " " + sender
        m.fromLabel.visible = true
    else
        m.fromLabel.visible = false
    end if
end sub
