' SiteFetch - opens web pages from the TV for SiteSearchTask and FindVideoTask (Task threads only:
' roUrlTransfer isn't allowed on the render thread).

function sfTransfer(url as String, referer as String, port as Object) as Object
    xfer = CreateObject("roUrlTransfer")
    xfer.SetMessagePort(port)
    xfer.SetUrl(url)
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.InitClientCertificates()
    xfer.EnableEncodings(true)
    xfer.AddHeader("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")
    xfer.AddHeader("Accept", "text/html,application/xhtml+xml,*/*;q=0.8")
    xfer.AddHeader("Accept-Language", "en-US,en;q=0.9")
    if referer <> "" then xfer.AddHeader("Referer", referer)
    return xfer
end function

function sfIsVideoType(contentType as String) as Boolean
    lowered = LCase(contentType)
    return (Left(lowered, 6) = "video/" or Instr(1, lowered, "mpegurl") > 0)
end function

' What kind of file an address is, without downloading it. "" if the site doesn't say.
function sfContentType(url as String) as String
    port = CreateObject("roMessagePort")
    xfer = sfTransfer(url, "", port)
    if not xfer.AsyncHead() then return ""
    msg = wait(6000, port)
    if type(msg) <> "roUrlEvent"
        xfer.AsyncCancel()
        return ""
    end if
    if msg.GetResponseCode() < 200 or msg.GetResponseCode() >= 300 then return ""
    return asStr(msg.GetResponseHeaders()["content-type"])
end function

' {page: text} | {video: true, contentType} when the address is a video file | {error}.
function sfFetchPage(url as String, referer as String, slot as String) as Object
    port = CreateObject("roMessagePort")
    xfer = sfTransfer(url, referer, port)
    path = "tmp:/" + slot + ".html"
    problem = { error: "Couldn't open that page from the TV. Check its internet connection." }
    if not xfer.AsyncGetToFile(path) then return problem
    msg = wait(15000, port)
    if type(msg) <> "roUrlEvent"
        xfer.AsyncCancel()
        DeleteFile(path)
        return { error: "That site took too long to answer." }
    end if
    code = msg.GetResponseCode()
    contentType = asStr(msg.GetResponseHeaders()["content-type"])
    if code < 200 or code >= 300
        DeleteFile(path)
        if code > 0 then return { error: "That site answered with error " + code.ToStr() + "." }
        return problem
    end if
    if sfIsVideoType(contentType)
        DeleteFile(path)
        return { video: true, contentType: contentType }
    end if
    info = CreateObject("roFileSystem").Stat(path)
    size = 0
    if type(info) = "roAssociativeArray" then size = asInt(info.size, 0)
    if size > 3000000
        DeleteFile(path)
        return { error: "That page is too big to read on the TV." }
    end if
    page = ReadAsciiFile(path)
    DeleteFile(path)
    return { page: page }
end function
