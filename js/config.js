/* Deployment settings. The portal itself is a static site; everything that differs between
   the lab-internal copy and the public one lives here (or in the URL, see below).

   dataBase      where catalog.json and the .pmtiles files live. A page may override it with
                 ?data=/some/path/ — same-origin paths only, so a link cannot point the map at
                 someone else's tiles.
   cogBase       public address of the GeoTIFFs. Empty until the archive is published; the
                 Download tab then lists the files without links.
   requestEmail  where on-demand requests are sent.
   requestEndpoint  address of the request Worker (worker/). When set, the "Request a region" form is
                 posted there and arrives as an email; when empty, the form opens an email draft.
                 It is set here and never from the page address, so a crafted link cannot redirect
                 what people type.
   demandLagMonths  how far behind "today" a request can reach (input data arrive late). */
window.PORTAL_CONFIG = {
  dataBase: "./data/",
  cogBase: "",
  requestEmail: "hyunglokkim@gist.ac.kr",
  requestEndpoint: "https://prithvi-openet-requests.hyunglokkim.workers.dev",
  demandFirstMonth: "2013-04",
  demandLagMonths: 3,
};
