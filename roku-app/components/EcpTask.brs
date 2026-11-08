' EcpTask - talks to this TV's own remote-control service (Roku ECP on port 8060), the same one
' Roku Detox uses from a computer. Roku apps can't open other apps themselves, but they can ask
' their own TV to, so Detox Home needs no computer. Runs on a Task thread because roUrlTransfer
' isn't allowed on the render thread.

sub init()
    m.top.functionName = "runRequest"
end sub

sub runRequest()
    req = m.top.request
    result = { tag: "", ok: false, code: 0, host: "", error: "" }
    if type(req) <> "roAssociativeArray"
        result.error = "bad request"
        m.top.response = result
        return
    end if
    result.tag = asStr(req.tag)
    method = UCase(asStr(req.method))
    if method <> "POST" then method = "GET"
    path = asStr(req.path)
    if path = ""
        result.error = "no path"
        m.top.response = result
        return
    end if

    ' The address that answered last time first, then each of the TV's own addresses.
    hosts = []
    known = asStr(req.host)
    if known <> "" then hosts.Push(known)
    for each ip in ownAddresses()
        if not hasValue(hosts, ip) then hosts.Push(ip)
    end for
    if not hasValue(hosts, "127.0.0.1") then hosts.Push("127.0.0.1")

    for each host in hosts
        answer = sendOnce(host, method, path)
        if answer.code > 0
            result.code = answer.code
            result.host = host
            if answer.code >= 200 and answer.code < 300
                result.ok = true
                if result.tag = "apps" then result.apps = parseApps(answer.text)
                if result.tag = "device" then result.name = parseDeviceName(answer.text)
            else
                result.error = "HTTP " + answer.code.ToStr()
            end if
            m.top.response = result
            return
        end if
        result.error = answer.error
    end for
    m.top.response = result
end sub

' {code (0 = no answer), text, error}
function sendOnce(host as String, method as String, path as String) as Object
    out = { code: 0, text: "", error: "" }
    port = CreateObject("roMessagePort")
    xfer = CreateObject("roUrlTransfer")
    xfer.SetMessagePort(port)
    xfer.SetUrl("http://" + host + ":8060/" + path)
    xfer.RetainBodyOnError(true)
    started = false
    if method = "POST"
        started = xfer.AsyncPostFromString("")
    else
        started = xfer.AsyncGetToString()
    end if
    if not started
        out.error = "could not start request"
        return out
    end if

    clock = CreateObject("roTimespan")
    clock.Mark()
    while true
        remaining = 4000 - clock.TotalMilliseconds()
        if remaining <= 0 then exit while
        msg = wait(remaining, port)
        if msg = invalid then exit while
        if type(msg) = "roUrlEvent"
            if msg.GetInt() = 1
                code = msg.GetResponseCode()
                if code > 0
                    out.code = code
                    out.text = msg.GetString()
                else
                    out.error = asStr(msg.GetFailureReason())
                    if out.error = "" then out.error = "no answer"
                end if
                return out
            end if
        end if
    end while
    xfer.AsyncCancel()
    out.error = "timeout"
    return out
end function

' The TV's own network addresses (one per connection: Wi-Fi, Ethernet).
function ownAddresses() as Object
    out = []
    addrs = CreateObject("roDeviceInfo").GetIPAddrs()
    if type(addrs) = "roAssociativeArray"
        for each name in addrs
            ip = asStr(addrs[name])
            if ip <> "" then out.Push(ip)
        end for
    end if
    return out
end function

' query/apps -> [{id, name, kind: "app"|"input", port}], in the TV's own order.
' Leaves out Detox Home itself ("dev") and the home screen.
function parseApps(text as String) as Object
    out = []
    xml = CreateObject("roXMLElement")
    if not xml.Parse(text) then return out
    for each node in xml.GetNamedElements("app")
        attrs = node.GetAttributes()
        id = asStr(attrs.id)
        kind = LCase(asStr(attrs.type))
        name = asStr(node.GetText())
        name = name.Trim()
        if id <> "" and id <> "dev" and kind <> "menu"
            if name = "" then name = id
            entry = { id: id, name: name, kind: "app", port: "" }
            if kind = "tvin" or LCase(Left(id, 8)) = "tvinput."
                entry.kind = "input"
                entry.port = inputPort(id)
            end if
            out.Push(entry)
        end if
    end for
    return out
end function

' "tvinput.hdmi2" -> "HDMI 2"
function inputPort(id as String) as String
    low = LCase(id)
    if Left(low, 12) = "tvinput.hdmi" then return "HDMI " + Mid(low, 13)
    if low = "tvinput.dtv" then return "Antenna"
    if low = "tvinput.cvbs" then return "AV"
    return ""
end function

' query/device-info -> the name people gave the TV ("Living Room TV"), or "".
function parseDeviceName(text as String) as String
    xml = CreateObject("roXMLElement")
    if not xml.Parse(text) then return ""
    for each tag in ["user-device-name", "friendly-device-name"]
        for each node in xml.GetNamedElements(tag)
            name = asStr(node.GetText())
            name = name.Trim()
            if name <> "" then return name
        end for
    end for
    return ""
end function
