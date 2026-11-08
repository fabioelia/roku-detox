' SiteSearchTask - opens a site's search page and reads the results (see SiteSearch.brs).

sub init()
    m.top.functionName = "searchSite"
end sub

sub searchSite()
    req = m.top.request
    site = req.site
    out = { order: asInt(req.order, 0), site: asStr(site.name), results: [], error: "" }
    query = asStr(req.query)
    url = ssSearchUrl(asStr(site.search), query)
    if url = ""
        out.error = "Its search address needs fixing under My sites."
    else if asBool(site.p) and ssIsLocalHost(ssUrlParts(url).host)
        out.error = "It was added from a phone and points at the home network."
    else
        fetched = sfFetchPage(url, "", asStr(req.slot))
        if ssIsStr(fetched.error)
            out.error = fetched.error
        else if ssIsStr(fetched.page)
            read = ssReadResults(url, fetched.page, query)
            if ssIsStr(read.error)
                out.error = read.error
            else
                out.results = read.results
            end if
        end if
    end if
    m.top.response = out
end sub
