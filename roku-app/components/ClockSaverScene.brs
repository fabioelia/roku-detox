' ClockSaverScene - the "Detox Clock" screensaver.

sub init()
    ' Text sizes (see setFont in DetoxUtils.brs).
    applyFonts([["timeLabel", 168, false], ["dateLabel", 48, false]])
    m.top.backgroundURI = ""
    m.top.backgroundColor = "0x000000FF"

    m.clockGroup = m.top.findNode("clockGroup")
    m.timeLabel = m.top.findNode("timeLabel")
    m.dateLabel = m.top.findNode("dateLabel")
    m.tickTimer = m.top.findNode("tickTimer")
    m.moveTimer = m.top.findNode("moveTimer")
    m.use24 = false

    ' Approximate size of the clock block, used to keep it fully on screen.
    m.blockW = 820
    m.blockH = 290
    m.margin = 60

    m.tickTimer.observeField("fire", "onTick")
    m.moveTimer.observeField("fire", "moveClock")

    onTick()
    moveClock()
    m.tickTimer.control = "start"
    m.moveTimer.control = "start"
end sub

sub onClock24Changed()
    if m.timeLabel = invalid then return
    m.use24 = m.top.clock24
    onTick()
end sub

sub onTick()
    dt = localNow()
    m.timeLabel.text = formatTime(dt, m.use24)
    m.dateLabel.text = formatDate(dt)
end sub

sub moveClock()
    rangeX = 1920 - m.margin * 2 - m.blockW
    rangeY = 1080 - m.margin * 2 - m.blockH
    x = m.margin + Rnd(rangeX) - 1
    y = m.margin + Rnd(rangeY) - 1
    m.clockGroup.translation = [x, y]
end sub
