' Small helpers shared by several components (included with a second <script> tag).
' Values coming from JSON / node fields may be boxed (roString, roBoolean, roInt...),
' so these check both forms.

function asStr(v as Dynamic) as String
    t = type(v)
    if t = "String" or t = "roString" then return v
    if t = "Integer" or t = "roInt" or t = "roInteger" or t = "LongInteger" or t = "roLongInteger" then return v.ToStr()
    if t = "Float" or t = "roFloat" or t = "Double" or t = "roDouble" then return Str(v).Trim()
    return ""
end function

function asBool(v as Dynamic) as Boolean
    t = type(v)
    if t = "Boolean" or t = "roBoolean" then return v
    return false
end function

function asInt(v as Dynamic, fallback as Integer) as Integer
    t = type(v)
    if t = "Integer" or t = "roInt" or t = "roInteger" or t = "LongInteger" or t = "roLongInteger" then return Int(v)
    if t = "Float" or t = "roFloat" or t = "Double" or t = "roDouble" then return Int(v)
    return fallback
end function

function asArray(v as Dynamic) as Object
    if type(v) = "roArray" then return v
    return []
end function

' Roku can't load its system font by file name, so a label starts from a built-in
' system font and is then resized (label.font becomes a Font node we can change).
sub setFont(label as Object, size as Integer, bold as Boolean)
    if label = invalid then return
    if bold
        label.font = "font:LargeBoldSystemFont"
    else
        label.font = "font:LargeSystemFont"
    end if
    label.font.size = size
end sub

' list: [[label id, size, bold], ...] for labels in this component.
sub applyFonts(list as Object)
    for each entry in list
        setFont(m.top.findNode(entry[0]), entry[1], entry[2])
    end for
end sub

function twoDigits(n as Integer) as String
    s = n.ToStr()
    if n < 10 then s = "0" + s
    return s
end function

' "9:41 PM" or "21:41"
function formatTime(dt as Object, use24 as Boolean) as String
    h = dt.GetHours()
    mins = twoDigits(dt.GetMinutes())
    if use24 then return twoDigits(h) + ":" + mins
    suffix = "AM"
    if h >= 12 then suffix = "PM"
    h12 = h mod 12
    if h12 = 0 then h12 = 12
    return h12.ToStr() + ":" + mins + " " + suffix
end function

' "Saturday, November 7"
function formatDate(dt as Object) as String
    months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    monthIdx = dt.GetMonth() - 1
    if monthIdx < 0 or monthIdx > 11 then monthIdx = 0
    day = dt.GetDayOfMonth()
    return dt.GetWeekday() + ", " + months[monthIdx] + " " + day.ToStr()
end function

function localNow() as Object
    dt = CreateObject("roDateTime")
    dt.ToLocalTime()
    return dt
end function
