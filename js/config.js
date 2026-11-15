/* Deployment settings. The portal itself is a static site; everything that differs between
   the lab-internal copy and the public one lives here (or in the URL, see below).

   dataBase      where catalog.json and the .pmtiles files live. The public site reads a reduced copy
                 of the tiles (zoom 3-10) from GitHub Pages; a copy that holds the full set says so in
                 its catalog and the portal then goes down to 30 m. A page may override it with
                 ?data=/some/path/ — same-origin paths only, so a link cannot point the map at
                 someone else's tiles.
   cogBase       public address of the GeoTIFFs. Empty until the archive is published; the
                 Download tab then lists the files without links.
   requestEmail  where on-demand requests are sent.
   requestEndpoint  address of the request Worker (worker/). When set, the "Request a region" form is
                 posted there and arrives as an email; when empty, the form opens an email draft.
                 It is set here and never from the page address, so a crafted link cannot redirect
                 what people type.
   demandLagMonths  how far behind "today" a request can reach (input data arrive late).
   paperStatus   where the paper stands, in words that finish "While the paper is …" and "Manuscript …".
                 The notes on the map about what is published so far, and the citation, use it.
                 Empty at publication: the notes then drop that clause.
   notice        one line shown at the very top of the page: where the paper stands and when the data
                 will be released. Empty it and the line is gone. */
window.PORTAL_CONFIG = {
  dataBase: "https://hyunglok-kim.github.io/prithvi-openet-tiles-1/",
  cogBase: "",
  requestEmail: "hyunglokkim@gist.ac.kr",
  requestEndpoint: "https://prithvi-openet-requests.hyunglokkim.workers.dev",
  demandFirstMonth: "2013-04",
  demandLagMonths: 3,
  paperStatus: "under review",
  notice: "The paper on this dataset is under review. The data will be released after the paper is accepted; what you see here is a preview.",
};
