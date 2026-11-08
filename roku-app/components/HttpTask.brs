' HttpTask - runs in its own thread (roUrlTransfer is not allowed on the render thread).

sub init()
    m.top.functionName = "runRequest"
end sub

sub runRequest()
    req = m.top.request
    result = { tag: "", ok: false, code: 0, error: "" }
    if type(req) <> "roAssociativeArray"
        result.error = "bad request"
        m.top.response = result
        return
    end if
    if req.tag <> invalid then result.tag = req.tag
    url = ""
    if req.url <> invalid then url = req.url
    if url = ""
        result.error = "no url"
        m.top.response = result
        return
    end if

    port = CreateObject("roMessagePort")
    xfer = CreateObject("roUrlTransfer")
    xfer.SetMessagePort(port)

    ' Query string (values are URL-encoded here because Escape() needs roUrlTransfer).
    if type(req.query) = "roAssociativeArray"
        parts = []
        for each k in req.query
            v = req.query[k]
            vt = type(v)
            if vt = "Invalid" or vt = "roInvalid"
                v = ""
            else if vt <> "String" and vt <> "roString"
                v = v.ToStr()
            end if
            parts.Push(xfer.Escape(k) + "=" + xfer.Escape(v))
        end for
        if parts.Count() > 0
            sep = "?"
            if Instr(1, url, "?") > 0 then sep = "&"
            qs = ""
            for i = 0 to parts.Count() - 1
                if i > 0 then qs = qs + "&"
                qs = qs + parts[i]
            end for
            url = url + sep + qs
        end if
    end if

    xfer.SetUrl(url)
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.InitClientCertificates()
    token = ""
    if req.token <> invalid then token = req.token
    xfer.AddHeader("X-Detox-Device", token)
    xfer.AddHeader("Accept", "application/json")
    xfer.RetainBodyOnError(true)

    method = "GET"
    if req.method <> invalid then method = UCase(req.method)

    started = false
    if method = "POST"
        body = "{}"
        if req.body <> invalid
            if req.body <> "" then body = req.body
        end if
        xfer.AddHeader("Content-Type", "application/json")
        started = xfer.AsyncPostFromString(body)
    else
        started = xfer.AsyncGetToString()
    end if

    if not started
        result.error = "could not start request"
        m.top.response = result
        return
    end if

    timeoutMs = 8000
    clock = CreateObject("roTimespan")
    clock.Mark()
    done = false
    while not done
        remaining = timeoutMs - clock.TotalMilliseconds()
        if remaining <= 0 then exit while
        msg = wait(remaining, port)
        if msg = invalid then exit while
        if type(msg) = "roUrlEvent"
            if msg.GetInt() = 1
                done = true
                code = msg.GetResponseCode()
                result.code = code
                text = msg.GetString()
                data = invalid
                if text <> "" then data = ParseJson(text)
                if data <> invalid then result.data = data
                if code >= 200 and code < 300
                    if data = invalid
                        result.error = "bad response"
                    else
                        result.ok = true
                    end if
                else
                    reason = msg.GetFailureReason()
                    if reason <> invalid then result.error = reason
                    if result.error = "" then result.error = "HTTP " + code.ToStr()
                end if
            end if
        end if
    end while

    if not done
        xfer.AsyncCancel()
        result.error = "timeout"
    end if

    if result.ok and result.tag = "config" then saveClockPref(result.data)

    m.top.response = result
end sub

' Lets the screensaver (which has no network) follow the Mac's 12/24-hour choice.
sub saveClockPref(data as Dynamic)
    if type(data) <> "roAssociativeArray" then return
    pref = "0"
    v = data.clock24
    vt = type(v)
    if vt = "Boolean" or vt = "roBoolean"
        if v then pref = "1"
    end if
    sec = CreateObject("roRegistrySection", "DetoxHome")
    if sec.Read("clock24") <> pref
        sec.Write("clock24", pref)
        sec.Flush()
    end if
end sub
