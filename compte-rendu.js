// ============================================================
// COMPTE-RENDU PHOTOGRAPHIQUE — MODULE PARTAGÉ
// ============================================================
// Générateur du compte-rendu PDF (plan de localisation + fiches photo) et les
// primitives géographiques dont il dépend. Extrait de index.html pour être
// utilisé à l'identique par l'application de bureau et par la PWA terrain :
// une seule mise en page à maintenir, un seul rendu pour le client.
//
// Script classique (pas un module) : les déclarations de premier niveau sont
// donc globales, et index.html continue de les appeler telles quelles.
//
// Dépendance : jsPDF (window.jspdf), chargé par la page appelante.
//
// Point d'entrée : buildPhotoReportPDF(points, setStatus, projectTitle)
//   points      : [{lat, lon, blob, displayName}] — photos géolocalisées
//   setStatus   : (texte) => void, pour l'avancement affiché
//   projectTitle: intitulé porté par le bandeau et les pieds de page
//   → renvoie le document jsPDF (doc.output('blob') pour l'enregistrer)

// Conversion WGS84 (degrés) -> Pseudo-Mercator EPSG:3857 (mètres), formule standard.
function toWebMercator(lon,lat){
  const R=6378137;
  const x=lon*Math.PI/180*R;
  const y=Math.log(Math.tan(Math.PI/4+(lat*Math.PI/180)/2))*R;
  return [x,y];
}
async function mapWithConcurrency(items,limit,fn){
  const results=new Array(items.length);
  let idx=0;
  async function worker(){
    while(idx<items.length){
      const i=idx++;
      results[i]=await fn(items[i],i);
    }
  }
  const workers=Array.from({length:Math.min(limit,items.length)},worker);
  await Promise.all(workers);
  return results;
}
function fromWebMercator(x,y){
  const R=6378137;
  const lon=x/R*180/Math.PI;
  const lat=(2*Math.atan(Math.exp(y/R))-Math.PI/2)*180/Math.PI;
  return [lon,lat];
}
// Coordonnées de tuile (fractionnaires) façon "slippy map" standard, dont le
// référentiel WMTS "PM" (Pseudo-Mercator) de l'IGN est un cas particulier.
function lonLatToTileXY(lon,lat,z){
  const n=Math.pow(2,z);
  const x=(lon+180)/360*n;
  const latRad=lat*Math.PI/180;
  const y=(1-Math.log(Math.tan(latRad)+1/Math.cos(latRad))/Math.PI)/2*n;
  return [x,y];
}
// Couche orthophoto IGN utilisée partout (fond du plan PDF et projet QGIS) :
// la mosaïque générale, pas un millésime. Les couches annuelles
// (ORTHOIMAGERY.ORTHOPHOTOS2024, 2023…) ne couvrent que les départements
// survolés cette année-là : ailleurs elles ne renvoient aucune tuile et le plan
// se retrouve sans fond de carte. La mosaïque générale couvre tout le
// territoire avec, en chaque point, la meilleure prise de vue disponible — donc
// aussi les secteurs livrés en très haute résolution, que les millésimes
// nationaux ne contiennent pas.
const IGN_ORTHO_LAYER='ORTHOIMAGERY.ORTHOPHOTOS';
// Niveau de zoom le plus fin réellement servi pour cette couche (voir
// verif-couverture.html, qui permet de le revérifier si l'IGN fait évoluer son
// service). Les niveaux 20 et 21 ne renvoient aucune tuile, nulle part.
const IGN_ORTHO_ZMAX=19;

// Choisit le zoom nécessaire pour que la mosaïque de tuiles fournisse au moins
// la résolution demandée (en pixels, pour la taille d'impression visée) —
// plutôt que de réduire le zoom pour limiter le nombre de tuiles (ce qui
// pixeliserait l'image une fois étirée sur le cadre). "minZoom" garantit un
// niveau de détail plancher ; "maxZoom" borne la demande.
function pickZoomForSpan(mercSpan,targetPixels,minZoom,maxZoom){
  const worldMerc=2*Math.PI*6378137; // circonférence terrestre en mètres Web Mercator
  const needed=Math.ceil(Math.log2((worldMerc*targetPixels)/(256*mercSpan)));
  return Math.max(minZoom,Math.min(maxZoom,needed));
}
// Tente de composer une image du fond de carte IGN (orthophotos) pour la bbox
// donnée (EPSG:4326) au zoom demandé. Renvoie un canvas prêt pour doc.addImage(),
// ou null si la connexion échoue, si le service ne répond pas avec des en-têtes
// CORS permissifs (canvas "taché"), ou si l'utilisateur est hors ligne — dans
// tous les cas on retombe silencieusement sur le plan schématique existant.
async function tryFetchIgnBasemap(lonMin,latMin,lonMax,latMax,zoom,maxTiles,minZoom,layer,format){
  layer=layer||IGN_ORTHO_LAYER;
  format=format||'image/jpeg';
  if(typeof navigator!=='undefined'&&navigator.onLine===false)return null;
  maxTiles=maxTiles||140;
  const HARD_MAX_TILES=420; // garde-fou absolu, même pour rester au zoom minimal demandé
  const TILE=256;
  const floorZoom=Math.max(6,minZoom==null?6:minZoom);
  try{
    // Grille de tuiles couvrant la bbox au zoom donné.
    const gridAt=z=>{
      const [xMinF,yMinF]=lonLatToTileXY(lonMin,latMax,z);
      const [xMaxF,yMaxF]=lonLatToTileXY(lonMax,latMin,z);
      const xTile0=Math.floor(xMinF),yTile0=Math.floor(yMinF);
      const nx=Math.floor(xMaxF)-xTile0+1,ny=Math.floor(yMaxF)-yTile0+1;
      if(nx<=0||ny<=0)return null;
      return {z,xMinF,yMinF,xMaxF,yMaxF,xTile0,yTile0,nx,ny};
    };
    const loadGrid=g=>{
      const tiles=[];
      for(let ty=0;ty<g.ny;ty++)for(let tx=0;tx<g.nx;tx++)tiles.push({tx,ty,col:g.xTile0+tx,row:g.yTile0+ty});
      return mapWithConcurrency(tiles,6,async t=>{
        const url='https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile'
          +'&LAYER='+layer+'&STYLE=normal&TILEMATRIXSET=PM'
          +'&TILEMATRIX='+g.z+'&TILEROW='+t.row+'&TILECOL='+t.col+'&FORMAT='+format;
        try{
          const img=new Image();
          img.crossOrigin='anonymous';
          const ready=new Promise((res,rej)=>{img.onload=res;img.onerror=()=>rej(new Error('tuile illisible'));});
          img.src=url;
          await Promise.race([ready,new Promise((_,rej)=>setTimeout(()=>rej(new Error('délai dépassé')),10000))]);
          return {...t,img};
        }catch(e){return {...t,img:null};}
      });
    };

    // Si le nombre de tuiles au zoom demandé dépasse le plafond de sécurité,
    // on réduit le zoom pas à pas (cas extrême : emprise très large) plutôt
    // que de renoncer — la priorité reste d'afficher un fond de carte. On ne
    // descend en revanche jamais sous minZoom (résolution minimale imposée par
    // l'appelant pour éviter la pixélisation) : au-delà, mieux vaut un repli
    // complet sur le plan schématique qu'un fond de carte flou.
    let g=gridAt(zoom);
    while(g&&g.nx*g.ny>maxTiles&&g.z>floorZoom)g=gridAt(g.z-1);
    if(!g||g.nx*g.ny>HARD_MAX_TILES)return null;

    // Le niveau de détail réellement servi dépend du secteur : la mosaïque
    // générale monte plus haut là où l'IGN dispose de prises de vue très haute
    // résolution qu'ailleurs. On demande donc le zoom idéal pour l'impression,
    // puis on redescend d'un cran tant que la dalle revient vide ou largement
    // lacunaire. Sans ce repli, viser un zoom élevé se paierait par un plan
    // sans fond de carte du tout dès que le secteur ne le sert pas.
    let loaded=null,coverage=0;
    for(;;){
      loaded=await loadGrid(g);
      const ok=loaded.reduce((n,t)=>n+(t.img?1:0),0);
      coverage=ok/loaded.length;
      // Quelques trous résiduels sont normaux en limite de couverture (littoral,
      // frontière) : ils ne justifient pas de perdre un niveau de détail.
      if(coverage>=0.75)break;
      const next=g.z>floorZoom?gridAt(g.z-1):null;
      if(!next){if(!ok)return null;break;}
      g=next;
    }

    const canvas=document.createElement('canvas');
    canvas.width=g.nx*TILE;canvas.height=g.ny*TILE;
    const ctx=canvas.getContext('2d');
    // Fond neutre avant l'assemblage : une tuile manquante doit se lire comme
    // une zone sans donnée. Un canvas laissé transparent virerait au noir à la
    // conversion JPEG, ce qui ressemblerait à un défaut d'impression.
    ctx.fillStyle='#e9edf0';ctx.fillRect(0,0,canvas.width,canvas.height);
    loaded.forEach(t=>{if(t.img)ctx.drawImage(t.img,t.tx*TILE,t.ty*TILE,TILE,TILE);});

    // recadrage précis sur la bbox demandée (les tuiles couvrent une zone un peu plus large)
    const cropX=(g.xMinF-g.xTile0)*TILE,cropY=(g.yMinF-g.yTile0)*TILE;
    const cropW=(g.xMaxF-g.xMinF)*TILE,cropH=(g.yMaxF-g.yMinF)*TILE;
    const out=document.createElement('canvas');
    out.width=Math.max(1,Math.round(cropW));out.height=Math.max(1,Math.round(cropH));
    const octx=out.getContext('2d',{willReadFrequently:true});
    octx.imageSmoothingEnabled=true;octx.imageSmoothingQuality='high';
    octx.drawImage(canvas,cropX,cropY,cropW,cropH,0,0,out.width,out.height);

    // Si une tuile provient d'un serveur sans en-têtes CORS permissifs, le canvas
    // devient "taché" : la lecture ci-dessous échoue et on retombe sur le schéma.
    octx.getImageData(0,0,1,1);
    // Part de la dalle réellement couverte par des tuiles : l'appelant s'en sert
    // pour décider si cette couche suffit ou s'il faut en essayer une autre.
    out.coverage=coverage;
    return out;
  }catch(e){
    return null;
  }
}
// ---- Compte-rendu photographique PDF ----
// Charge un Blob image dans un <img> via une URL locale (blob:), sans jamais
// passer par un serveur distant : pas de souci de CORS/tainted canvas pour jsPDF.
function loadImageElement(blob){
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(blob);
    const img=new Image();
    img.onload=()=>resolve({img,url});
    img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('image illisible'));};
    img.src=url;
  });
}

// ============================================================
// COMPTE-RENDU PHOTOGRAPHIQUE — CHARTE GRAPHIQUE
// ============================================================
// Deux rôles de couleur nettement séparés, comme sur un plan d'ingénierie :
//   « chrome » (accent)  → structure du document : filets, étiquettes de bloc ;
//   « data »             → tout ce qui porte l'information relevée : repères
//                          numérotés et emprise du plan. Une seule teinte,
//                          très lisible sur orthophoto, reprise à l'identique
//                          sur les fiches photo pour que la correspondance
//                          numéro ↔ photo soit immédiate.
// Les teintes sont plus sourdes que celles de l'interface écran : les verts et
// bleus fluo de l'app passent mal à l'impression.
const RP={
  ink:[17,21,27],        // titres
  inkSoft:[74,84,96],    // texte courant
  muted:[134,144,155],   // texte secondaire
  hair:[214,220,227],    // filets
  panel:[246,248,250],   // fonds de bloc
  paper:[255,255,255],
  accent:[13,124,102],   // chrome
  data:[209,62,36],      // repères + emprise
  dataDark:[142,38,20]
};
const RP_F='helvetica';

function rpThousands(n){return String(n).replace(/\B(?=(\d{3})+(?!\d))/g,' ');}
function rpLen(v){
  const r=Number(v.toFixed(1));
  return v>=1000?(Number((v/1000).toFixed(1))+' km'):(r+' m');
}

// Texte interlettré. Attention : jsPDF ignore setCharSpace aussi bien dans
// getTextWidth que dans son propre alignement (align:'right'/'center'), ce qui
// pousse le texte hors de la marge. On mesure donc la largeur réelle — le
// tracking s'applique entre les caractères, soit n-1 intervalles, en unités du
// document (vérifié au pixel) — et on positionne à la main.
function rpTracked(doc,text,x,y,spacing,align){
  const w=doc.getTextWidth(text)+spacing*Math.max(0,text.length-1);
  let dx=0;
  if(align==='right')dx=-w;else if(align==='center')dx=-w/2;
  doc.setCharSpace(spacing);
  doc.text(text,x+dx,y);
  doc.setCharSpace(0);
  return w;
}

// Étiquette de bloc : petites capitales interlettrées + filet de soulignement.
// Renvoie l'ordonnée où le contenu du bloc peut commencer.
function rpLabel(doc,text,x,y,w){
  doc.setFont(RP_F,'bold');doc.setFontSize(6.2);doc.setTextColor(...RP.accent);
  rpTracked(doc,text.toUpperCase(),x,y,0.55);
  doc.setDrawColor(...RP.accent);doc.setLineWidth(0.35);
  doc.line(x,y+1.5,x+w,y+1.5);
  doc.setTextColor(0);
  return y+6.4;
}

// Repère numéroté — dessin strictement identique sur le plan et sur les fiches
// photo : c'est ce qui permet de relier une photo à sa position d'un coup d'œil.
// Halo blanc systématique : reste lisible sur n'importe quel fond aérien.
// Le chiffre occupe le disque au plus près : à rayon égal, un numéro plus grand
// se lit de plus loin et supporte mieux la photocopie. Le facteur dépend du
// nombre de chiffres, sans quoi il faudrait le régler pour le pire cas — un
// numéro à trois chiffres — et gaspiller la place sur les repères courants, qui
// sont l'immense majorité.
function rpMarker(doc,x,y,label,r){
  const n=String(label).length;
  const fs=r*(n>=3?1.65:n===2?2.05:2.35);
  doc.setFillColor(...RP.paper);doc.circle(x,y,r+1.05,'F');
  doc.setFillColor(...RP.data);doc.circle(x,y,r,'F');
  doc.setDrawColor(...RP.dataDark);doc.setLineWidth(0.3);doc.circle(x,y,r,'S');
  doc.setFont(RP_F,'bold');doc.setFontSize(fs);doc.setTextColor(...RP.paper);
  doc.text(String(label),x,y+fs*0.1235,{align:'center'});
  doc.setTextColor(0);
}

// Rose des vents : disque clair, aiguille bipointe (nord plein / sud évidé).
function rpNorthArrow(doc,cx,cy,r){
  doc.setFillColor(...RP.paper);doc.circle(cx,cy,r,'F');
  doc.setDrawColor(...RP.hair);doc.setLineWidth(0.4);doc.circle(cx,cy,r,'S');
  const tip=cy-r*0.62,base=cy+r*0.50,waist=cy+r*0.14,half=r*0.29;
  doc.setFillColor(...RP.ink);
  doc.triangle(cx,tip,cx-half,base,cx,waist,'F');
  doc.setFillColor(...RP.paper);doc.setDrawColor(...RP.inkSoft);doc.setLineWidth(0.25);
  doc.triangle(cx,tip,cx+half,base,cx,waist,'FD');
  doc.setFont(RP_F,'bold');doc.setFontSize(r*1.2);doc.setTextColor(...RP.ink);
  doc.text('N',cx,cy-r-1.2,{align:'center'});
  doc.setTextColor(0);
}

// Échelle graphique (segments alternés) doublée de l'échelle numérique : sur un
// document imprimé puis photocopié/redimensionné, seule la barre reste juste —
// le ratio sert de repère de lecture rapide.
function rpScaleBar(doc,x,y,spanMeters,mapWmm){
  const mPerMm=spanMeters/mapWmm;
  const steps=[1,2,5,10,20,25,50,100,200,250,500,1000,2000,5000,10000,20000,50000];
  const ideal=mPerMm*(mapWmm*0.20);
  let len=steps[0];
  for(const s of steps){if(s<=ideal)len=s;else break;}
  const barW=len/mPerMm,barH=1.5,seg=barW/4;
  const plateW=Math.max(barW+8,36),plateH=14;
  doc.setFillColor(...RP.paper);doc.roundedRect(x,y,plateW,plateH,1,1,'F');
  doc.setDrawColor(...RP.hair);doc.setLineWidth(0.3);doc.roundedRect(x,y,plateW,plateH,1,1,'S');
  const bx=x+4,by=y+7.2;
  for(let i=0;i<4;i++){
    doc.setFillColor(...(i%2?RP.paper:RP.ink));
    doc.rect(bx+i*seg,by,seg,barH,'F');
  }
  doc.setDrawColor(...RP.ink);doc.setLineWidth(0.25);doc.rect(bx,by,barW,barH,'S');
  doc.setFont(RP_F,'normal');doc.setFontSize(5.6);doc.setTextColor(...RP.inkSoft);
  doc.text('0',bx,by-1.2,{align:'center'});
  doc.text(rpLen(len/2),bx+barW/2,by-1.2,{align:'center'});
  doc.text(rpLen(len),bx+barW,by-1.2,{align:'center'});
  doc.setFontSize(5.8);doc.setTextColor(...RP.muted);
  doc.text('1 : '+rpThousands(Math.round(mPerMm*1000)),bx,by+barH+3.2);
  doc.setTextColor(0);
}

// Définition d'impression visée pour le fond de plan. La mosaïque est demandée
// à RP_DPI_FETCH ; le zoom retenu étant le premier niveau qui atteint cette
// cible, la dalle obtenue fait entre 1 et 2 fois la définition demandée. On
// embarque jusqu'à RP_DPI_PRINT pour conserver ce surplus quand il existe, sans
// laisser le PDF enfler au-delà de ce qu'une imprimante restitue.
// RP_DPI_MIN est le plancher en dessous duquel le fond de carte cesse d'être
// présentable : c'est lui, et non un niveau de zoom fixe, qui borne les
// réductions de zoom quand l'emprise est trop large pour tenir dans le budget de
// tuiles.
// RP_DPI_FLOOR : définition en deçà de laquelle on cesse de resserrer le cadrage
// (voir l'emprise minimale dans buildPhotoReportPDF).
const RP_DPI_FETCH=240,RP_DPI_PRINT=300,RP_DPI_MIN=120,RP_DPI_FLOOR=110;

// Rayon du repère chiffré du plan, et rayon de son halo blanc. Le repère est
// volontairement petit : il ne porte qu'un numéro d'index, la position exacte
// étant lue au bout de son trait de rappel. Un repère plus gros mangeait le fond
// de carte qu'il est censé qualifier. Tout l'espacement du plan se déduit de ces
// deux valeurs, elles ne sont donc à changer qu'ici.
const RP_MARK_R=2.5,RP_MARK_HALO=RP_MARK_R+1.05;

// Sources du fond de plan, essayées dans l'ordre. L'orthophoto générale est la
// plus complète que publie l'IGN, mais « la plus complète » n'est pas « partout,
// à tous les niveaux de zoom » : le littoral et les frontières comportent des
// dalles sans donnée, les niveaux les plus fins ne sont pas servis sur tout le
// territoire, et les collectivités d'outre-mer ne sont pas toutes dans la
// mosaïque métropolitaine. Le Plan IGN, lui, est dérivé de la BD TOPO et couvre
// l'ensemble du territoire ; il ne montre pas le terrain mais il situe le
// chantier, ce qui vaut infiniment mieux qu'un cadre vide. On retient donc la
// première source qui revient franchement couverte, sinon la moins lacunaire.
const RP_BASEMAP_SOURCES=[
  {layer:IGN_ORTHO_LAYER,format:'image/jpeg',label:'Orthophotos',photo:true},
  {layer:'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2',format:'image/png',label:'Plan IGN',photo:false}
];
async function rpFetchPlanBasemap(lonMin,latMin,lonMax,latMax,zoom,maxTiles,minZoom){
  let best=null;
  for(const src of RP_BASEMAP_SOURCES){
    const img=await tryFetchIgnBasemap(lonMin,latMin,lonMax,latMax,zoom,maxTiles,minZoom,src.layer,src.format);
    if(!img)continue;
    const cov=img.coverage==null?1:img.coverage;
    if(!best||cov>best.coverage)best={img,coverage:cov,label:src.label,photo:src.photo};
    if(cov>=0.6)break;
  }
  return best;
}

// Retouche de l'orthophoto pour le papier. Une prise de vue aérienne brute
// s'imprime terne : le contraste s'écrase, les toitures et la voirie virent au
// gris et les limites de parcelle deviennent difficiles à suivre. Trois
// corrections légères, dans une seule passe sur les pixels :
//   - accentuation (noyau en croix) pour redonner du mordant aux arêtes après
//     le rééchantillonnage,
//   - reprise de contraste avec une très légère ouverture des ombres, sinon les
//     zones d'ombre portée se bouchent complètement à l'impression,
//   - saturation à peine relevée, pour distinguer végétation et minéral.
// Les valeurs restent volontairement basses : il s'agit d'un document technique,
// l'image doit rester fidèle à la prise de vue.
function rpEnhanceOrtho(canvas){
  const w=canvas.width,h=canvas.height;
  if(w<8||h<8)return canvas;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  let img;
  try{img=ctx.getImageData(0,0,w,h);}catch(e){return canvas;} // canvas taché : on n'y touche pas
  const d=img.data;
  const src=new Uint8ClampedArray(d); // référence figée : le noyau lit l'image d'origine
  const A=0.20,C=1+4*A;               // accentuation : centre - voisins
  const SAT=1.08;
  const lut=new Uint8Array(256);
  for(let i=0;i<256;i++){
    let v=(i/255-0.5)*1.07+0.5;
    v=Math.pow(v<0?0:v>1?1:v,0.97);
    lut[i]=Math.round(v*255);
  }
  const row=w*4;
  for(let y=0;y<h;y++){
    const edgeRow=(y===0||y===h-1);
    for(let x=0;x<w;x++){
      const i=(y*w+x)*4;
      let r,g,b;
      if(edgeRow||x===0||x===w-1){
        r=src[i];g=src[i+1];b=src[i+2];
      }else{
        const up=i-row,dn=i+row,le=i-4,ri=i+4;
        r=C*src[i]  -A*(src[up]  +src[dn]  +src[le]  +src[ri]);
        g=C*src[i+1]-A*(src[up+1]+src[dn+1]+src[le+1]+src[ri+1]);
        b=C*src[i+2]-A*(src[up+2]+src[dn+2]+src[le+2]+src[ri+2]);
        r=r<0?0:r>255?255:r;g=g<0?0:g>255?255:g;b=b<0?0:b>255?255:b;
      }
      r=lut[r|0];g=lut[g|0];b=lut[b|0];
      const luma=0.299*r+0.587*g+0.114*b;
      // d est un Uint8ClampedArray : l'écriture arrondit et borne d'elle-même.
      d[i]=luma+(r-luma)*SAT;
      d[i+1]=luma+(g-luma)*SAT;
      d[i+2]=luma+(b-luma)*SAT;
    }
  }
  ctx.putImageData(img,0,0);
  return canvas;
}

// Ramène une dalle à la définition réellement utile pour le cadre imprimé (mm).
// Le rééchantillonnage est fait ici, avec un filtrage de qualité, plutôt que
// laissé au moteur de rendu du PDF : réduire une image nette donne un résultat
// bien plus propre que d'embarquer deux fois trop de pixels et de laisser le
// lecteur les écraser à la volée — et le fichier s'en trouve allégé. On
// n'agrandit jamais : au-delà de ce que la mosaïque contient, il n'y a plus
// d'information à gagner, seulement du poids.
function rpFitRaster(src,mmW,mmH){
  const scale=Math.min(1,(mmW/25.4*RP_DPI_PRINT)/src.width,(mmH/25.4*RP_DPI_PRINT)/src.height);
  if(scale>=0.999)return src;
  const out=document.createElement('canvas');
  out.width=Math.max(1,Math.round(src.width*scale));
  out.height=Math.max(1,Math.round(src.height*scale));
  const c=out.getContext('2d',{willReadFrequently:true});
  c.imageSmoothingEnabled=true;c.imageSmoothingQuality='high';
  c.drawImage(src,0,0,out.width,out.height);
  return out;
}
function rpPrepareOrtho(src,mmW,mmH){
  return rpEnhanceOrtho(rpFitRaster(src,mmW,mmH));
}

// jsPDF convertit les canvas en JPEG qualité 1 : sur le fond de plan cela pèse
// trois fois plus lourd sans différence visible à l'impression. On maîtrise donc
// l'encodage ici. En cas de canvas "taché" (tuile sans en-tête CORS), on rend le
// canvas tel quel : jsPDF échouera de la même façon, mais le repli reste géré.
function rpJpeg(canvas,q){
  try{return canvas.toDataURL('image/jpeg',q||0.92);}catch(e){return canvas;}
}

// Place les repères numérotés autour des positions relevées. Le repère n'est
// jamais posé SUR son point : il est systématiquement déporté et relié par un
// segment terminé par un point qui, lui, marque la position exacte. La lecture
// est ainsi toujours la même — le chiffre se lit dans le dégagement, la mesure
// se lit au bout du trait — au lieu de dépendre de la densité locale, où un
// repère posé sur son point masquait justement ce qu'il désignait.
//
// Trois contraintes, relâchées ensemble à chaque passe :
//   1. longueur du segment tenue entre LEAD_MIN et LEAD_MAX, pour que le trait
//      et son point sortent franchement du halo du repère (rayon 4,55 mm) sans
//      partir à l'autre bout du plan ;
//   2. distance minimale entre deux repères (leur diamètre visuel) ;
//   3. dégagement entre un repère et le point exact d'un AUTRE repère, sinon un
//      chiffre vient se poser pile sur la position qu'il ne désigne pas.
// Toutes les paires sont réexaminées à chaque passe : un conflit créé par un
// déplacement est corrigé à la passe suivante.
function computeLabelLayout(projected,planX,planY,planW,planH){
  const n=projected.length;
  // Tout se déduit du halo du repère (RP_MARK_HALO) : 2,5 mm de blanc franc
  // entre deux voisins, là où s'en tenir au diamètre les rendait tangents —
  // lisibles à la loupe, collés à l'œil ; et un segment assez long pour dépasser
  // du halo de 5 mm, sans quoi il ne se voit pas.
  const MARK_MIN=RP_MARK_HALO*2+2.5;
  // Le segment peut s'allonger avec le nombre de repères : n repères espacés de
  // MARK_MIN autour d'un même amas demandent un rayon d'au moins n·MARK_MIN/2π.
  // Sans cette marge, la contrainte de longueur et celle d'écartement deviennent
  // contradictoires au-delà de neuf points confondus, et c'est l'écartement qui
  // cède — soit exactement ce qu'on cherche à éviter.
  const LEAD_MIN=RP_MARK_HALO+5,LEAD_MAX=Math.max(18,(MARK_MIN*n)/(2*Math.PI)+4);
  const CLEAR_PT=RP_MARK_HALO+1.15; // le point exact d'un voisin reste hors du halo
  // Marge de cadre au plus juste : de quoi garder le halo entièrement dans le
  // plan, pas davantage. Une marge plus large n'apportait rien et privait de
  // place les amas tombant près d'un bord, où chaque millimètre d'arc compte
  // pour écarter les repères.
  const margin=RP_MARK_HALO+2;
  const minX=planX+margin,maxX=planX+planW-margin,minY=planY+margin,maxY=planY+planH-margin;
  const clampX=v=>Math.min(maxX,Math.max(minX,v));
  const clampY=v=>Math.min(maxY,Math.max(minY,v));

  // Direction de départ : à l'opposé des points voisins, pondérés par l'inverse
  // du carré de la distance, pour que chaque segment sorte du côté dégagé de son
  // propre amas. Se caler sur le seul barycentre général donnait à trois points
  // serrés trois directions quasi identiques : les repères finissaient alignés
  // en file au lieu de s'ouvrir en étoile. Repli sur le barycentre puis sur un
  // angle déterministe (points isolés ou parfaitement symétriques), pour rester
  // reproductible d'un rendu à l'autre.
  const cx=projected.reduce((s,p)=>s+p.x,0)/n,cy=projected.reduce((s,p)=>s+p.y,0)/n;
  const dirOf=i=>{
    let vx=0,vy=0;
    for(let j=0;j<n;j++){
      if(j===i)continue;
      const dx=projected[i].x-projected[j].x,dy=projected[i].y-projected[j].y;
      const d=Math.hypot(dx,dy);
      if(d<0.01||d>28)continue;
      vx+=dx/(d*d);vy+=dy/(d*d);
    }
    let d=Math.hypot(vx,vy);
    if(d<1e-4){vx=projected[i].x-cx;vy=projected[i].y-cy;d=Math.hypot(vx,vy);}
    if(d<0.5){const a=i*2.399963+2.2;return [Math.cos(a),Math.sin(a)];}
    return [vx/d,vy/d];
  };
  // Longueur de départ ajustée à l'encombrement local : k repères à placer
  // autour d'un même amas demandent un rayon d'au moins k·MARK_MIN/2π. Partir
  // systématiquement de LEAD_MIN posait les repères d'un amas serré sur un cercle
  // trop petit pour eux ; les poussées d'écartement, tangentes à ce cercle, ne
  // l'élargissaient pas et une douzaine de prises de vue faites du même endroit
  // restaient collées quel que soit le nombre de passes.
  // Amas locaux : les repères d'un même amas partent en éventail régulier, sur un
  // rayon dimensionné pour eux (k repères espacés de MARK_MIN demandent au moins
  // k·MARK_MIN/2π). Les poussées d'écartement, tangentes au cercle de départ, ne
  // savent pas l'élargir ni séparer des repères partis dans la même direction :
  // une douzaine de prises de vue faites du même endroit restaient collées quel
  // que soit le nombre de passes. L'éventail règle les deux d'emblée, la
  // relaxation n'a plus qu'à corriger les conflits entre amas voisins.
  const near=projected.map((p,i)=>{
    const g=[];
    for(let j=0;j<n;j++)if(Math.hypot(p.x-projected[j].x,p.y-projected[j].y)<LEAD_MIN*1.6)g.push(j);
    return g;
  });
  const pos=projected.map((p,i)=>{
    const g=near[i],k=g.length;
    const [ux,uy]=dirOf(k>1?g[0]:i);
    const ang=Math.atan2(uy,ux)+(k>1?(2*Math.PI*g.indexOf(i))/k:0);
    const r=Math.max(LEAD_MIN,Math.min(LEAD_MAX,(MARK_MIN*k)/(2*Math.PI)+0.6));
    return {x:clampX(p.x+Math.cos(ang)*r),y:clampY(p.y+Math.sin(ang)*r)};
  });

  // Ordre des contraintes dans la passe : la longueur du segment d'abord, les
  // conflits entre repères ensuite. L'inverse laissait le rappel radial défaire
  // l'écartement tout juste obtenu, et des repères restaient superposés dans les
  // amas denses.
  for(let iter=0;iter<120;iter++){
    let moved=false;
    for(let i=0;i<n;i++){
      const dx=pos[i].x-projected[i].x,dy=pos[i].y-projected[i].y;
      let d=Math.hypot(dx,dy),ux,uy;
      if(d<0.01){const [a,b]=dirOf(i);ux=a;uy=b;d=0.01;}else{ux=dx/d;uy=dy/d;}
      const lead=d<LEAD_MIN?LEAD_MIN:d>LEAD_MAX?LEAD_MAX:d;
      if(lead!==d){
        moved=true;
        pos[i].x=projected[i].x+ux*lead;pos[i].y=projected[i].y+uy*lead;
      }
    }
    for(let i=0;i<n;i++){
      for(let j=i+1;j<n;j++){
        const dx=pos[j].x-pos[i].x,dy=pos[j].y-pos[i].y;
        let dist=Math.hypot(dx,dy);
        if(dist>=MARK_MIN)continue;
        moved=true;
        let ux,uy;
        if(dist<0.01){
          const a=(i*2.399963+j*0.618034)*Math.PI;
          ux=Math.cos(a);uy=Math.sin(a);dist=0.01;
        }else{ux=dx/dist;uy=dy/dist;}
        const push=(MARK_MIN-dist)/2+0.1;
        pos[i].x-=ux*push;pos[i].y-=uy*push;
        pos[j].x+=ux*push;pos[j].y+=uy*push;
      }
    }
    for(let i=0;i<n;i++)for(let j=0;j<n;j++){
      if(i===j)continue;
      const dx=pos[i].x-projected[j].x,dy=pos[i].y-projected[j].y;
      const dist=Math.hypot(dx,dy);
      if(dist>=CLEAR_PT)continue;
      moved=true;
      const a=dist<0.01?(i*1.7+j*0.9):Math.atan2(dy,dx);
      const ux=dist<0.01?Math.cos(a):dx/dist,uy=dist<0.01?Math.sin(a):dy/dist;
      pos[i].x+=ux*(CLEAR_PT-dist+0.1);pos[i].y+=uy*(CLEAR_PT-dist+0.1);
    }
    for(let i=0;i<n;i++){
      pos[i].x=clampX(pos[i].x);pos[i].y=clampY(pos[i].y);
    }
    if(!moved)break;
  }

  // Rattrapage des repères que le recadrage a ramenés sur leur point (bord de
  // cadre) : on essaie tout le tour et on garde la direction la plus dégagée,
  // celle qui laisse le trait visible sans venir buter sur un voisin.
  for(let i=0;i<n;i++){
    if(Math.hypot(pos[i].x-projected[i].x,pos[i].y-projected[i].y)>=LEAD_MIN-0.5)continue;
    let best=null,bestScore=-Infinity;
    for(let k=0;k<16;k++){
      const a=k*Math.PI/8;
      const x=clampX(projected[i].x+Math.cos(a)*LEAD_MIN);
      const y=clampY(projected[i].y+Math.sin(a)*LEAD_MIN);
      let score=Math.hypot(x-projected[i].x,y-projected[i].y)*2;
      for(let j=0;j<n;j++){
        if(j===i)continue;
        score+=Math.min(MARK_MIN,Math.hypot(x-pos[j].x,y-pos[j].y));
        score+=Math.min(CLEAR_PT,Math.hypot(x-projected[j].x,y-projected[j].y));
      }
      if(score>bestScore){bestScore=score;best={x,y};}
    }
    if(best)pos[i]=best;
  }

  // Garantie finale : plus aucun halo qui en recouvre un autre. Les passes
  // précédentes arbitrent entre trois contraintes concurrentes et peuvent, dans
  // une configuration très dense, s'arrêter sur un compromis où deux repères se
  // frôlent encore. Ici une seule règle s'applique, et elle prime sur la
  // longueur du segment : deux repères qui se chevauchent rendent le plan faux,
  // un segment un peu plus long ne gêne personne.
  const HARD=RP_MARK_HALO*2+0.6;
  for(let iter=0;iter<200;iter++){
    let chevauche=false;
    for(let i=0;i<n;i++){
      for(let j=i+1;j<n;j++){
        const dx=pos[j].x-pos[i].x,dy=pos[j].y-pos[i].y;
        let dist=Math.hypot(dx,dy);
        if(dist>=HARD)continue;
        chevauche=true;
        let ux,uy;
        if(dist<0.01){
          const a=(i*2.399963+j*0.618034)*Math.PI;
          ux=Math.cos(a);uy=Math.sin(a);dist=0.01;
        }else{ux=dx/dist;uy=dy/dist;}
        const push=(HARD-dist)/2+0.05;
        pos[i].x-=ux*push;pos[i].y-=uy*push;
        pos[j].x+=ux*push;pos[j].y+=uy*push;
      }
    }
    for(let i=0;i<n;i++){
      pos[i].x=clampX(pos[i].x);pos[i].y=clampY(pos[i].y);
    }
    if(!chevauche)break;
  }
  return pos;
}

// Vue de situation : fond Plan IGN élargi autour du site. La récupération est
// séparée du dessin pour que le cartouche puisse se réorganiser sans laisser de
// trou quand la connexion manque.
async function rpFetchInset(w,h,cxm,cym,spanX,spanY){
  const ratio=w/h;
  if(spanX/spanY<ratio)spanX=spanY*ratio;else spanY=spanX/ratio;
  const box={
    mxMin:cxm-spanX/2,mxMax:cxm+spanX/2,
    myMin:cym-spanY/2,myMax:cym+spanY/2
  };
  const [lo1,la1]=fromWebMercator(box.mxMin,box.myMin);
  const [lo2,la2]=fromWebMercator(box.mxMax,box.myMax);
  const z=Math.max(
    pickZoomForSpan(spanX,w/25.4*220,6,17),
    pickZoomForSpan(spanY,h/25.4*220,6,17)
  );
  const img=await tryFetchIgnBasemap(lo1,la1,lo2,la2,z,90,6,'GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2','image/png');
  return img?{img,box}:null;
}
// Vue rapprochée : les abords immédiats du chantier, quatorze fois l'emprise du
// plan, bornée pour rester lisible quelle que soit la taille du site.
function rpFetchSituation(w,h,mxMin,myMin,mxMax,myMax){
  return rpFetchInset(w,h,(mxMin+mxMax)/2,(myMin+myMax)/2,
    Math.min(35000,Math.max(2500,(mxMax-mxMin)*14)),
    Math.min(35000,Math.max(2500,(myMax-myMin)*14)));
}
// Vue départementale : emprise fixe d'environ 130 km au sol, de quoi faire
// tenir un département et ses voisins. Fixe et non proportionnelle à l'emprise
// du plan : c'est justement son intérêt, donner toujours le même repère
// géographique, celui qu'on lit sans réfléchir.
const RP_DEPT_SPAN=190000; // mètres Web Mercator (~130 km au sol sous nos latitudes)
function rpFetchDept(w,h,mxMin,myMin,mxMax,myMax){
  return rpFetchInset(w,h,(mxMin+mxMax)/2,(myMin+myMax)/2,RP_DEPT_SPAN,RP_DEPT_SPAN);
}

// Dessine la vue de situation + l'emprise du plan détaillé (rectangle rouge
// doublé d'un liseré blanc pour rester visible sur n'importe quel fond).
function rpDrawInset(doc,x,y,w,h,s){
  // Encodage à qualité élevée : l'encart est une carte (traits fins, toponymes
  // de 1 mm de haut), ce que la compression maltraite le plus. Le PNG serait
  // tentant, mais jsPDF embarque alors le canvas en RVB brut — 2 Mo pour un
  // encart de 5 cm, sans gain visible sur un tirage à 300 dpi.
  doc.addImage(rpJpeg(rpFitRaster(s.img,w,h),0.95),'JPEG',x,y,w,h);
  doc.setDrawColor(...RP.hair);doc.setLineWidth(0.35);doc.rect(x,y,w,h,'S');
  const b=s.box;
  return {
    toX:m=>x+(m-b.mxMin)/(b.mxMax-b.mxMin)*w,
    toY:m=>y+(b.myMax-m)/(b.myMax-b.myMin)*h
  };
}
// Emprise du plan détaillé, reportée sur l'encart rapproché : rectangle rouge
// doublé d'un liseré blanc pour rester visible sur n'importe quel fond.
function rpDrawExtent(doc,p,mxMin,myMin,mxMax,myMax){
  const rx=p.toX(mxMin),ry=p.toY(myMax);
  const rw=Math.max(1.4,p.toX(mxMax)-rx),rh=Math.max(1.4,p.toY(myMin)-ry);
  doc.setDrawColor(...RP.paper);doc.setLineWidth(1.3);doc.rect(rx,ry,rw,rh,'S');
  doc.setDrawColor(...RP.data);doc.setLineWidth(0.7);doc.rect(rx,ry,rw,rh,'S');
}
// À l'échelle du département, l'emprise du chantier mesure une fraction de
// millimètre : un rectangle y serait invisible. C'est donc une pastille qui
// marque le site, dimensionnée pour se voir sans masquer le toponyme voisin.
function rpDrawSitePoint(doc,p,mx,my){
  const x=p.toX(mx),y=p.toY(my);
  doc.setFillColor(...RP.paper);doc.circle(x,y,2.05,'F');
  doc.setFillColor(...RP.data);doc.circle(x,y,1.25,'F');
  doc.setDrawColor(...RP.dataDark);doc.setLineWidth(0.25);doc.circle(x,y,1.25,'S');
}

// En-tête répété sur chaque page de fiches photo.
function rpPhotoHeader(doc,pw,m,title){
  doc.setFont(RP_F,'bold');doc.setFontSize(10);doc.setTextColor(...RP.ink);
  doc.text(title,m,m-2.5);
  doc.setFont(RP_F,'normal');doc.setFontSize(6.4);doc.setTextColor(...RP.muted);
  rpTracked(doc,'COMPTE-RENDU PHOTOGRAPHIQUE',pw-m,m-2.5,0.5,'right');
  doc.setDrawColor(...RP.accent);doc.setLineWidth(0.7);
  doc.line(m,m,pw-m,m);
  doc.setTextColor(0);
  return m+8;
}

// Bloc de métadonnées du bandeau de titre : paires libellé/valeur posées de
// droite à gauche, largeurs mesurées pour un alignement propre.
function rpMetaBlock(doc,items,rightX,yLabel,yValue){
  let x=rightX;
  for(let i=items.length-1;i>=0;i--){
    const k=items[i][0],v=items[i][1];
    doc.setFont(RP_F,'bold');doc.setFontSize(10);
    const wv=doc.getTextWidth(v);
    doc.setFont(RP_F,'normal');doc.setFontSize(5.9);
    const wk=doc.getTextWidth(k)+0.55*Math.max(0,k.length-1);
    const cw=Math.max(wv,wk);
    doc.setTextColor(150,160,170);
    rpTracked(doc,k,x,yLabel,0.55,'right');
    doc.setFont(RP_F,'bold');doc.setFontSize(10);doc.setTextColor(255,255,255);
    doc.text(v,x,yValue,{align:'right'});
    x-=cw+9;
  }
  doc.setTextColor(0);
}

async function buildPhotoReportPDF(points,setStatus,projectTitle){
  projectTitle=projectTitle||'Photos géolocalisées';
  const {jsPDF}=window.jspdf;
  const doc=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'});
  doc.setProperties({title:projectTitle,subject:'Compte-rendu photographique'});
  const pw=doc.internal.pageSize.getWidth(),ph=doc.internal.pageSize.getHeight();
  const M=12;
  const today=new Date().toLocaleDateString('fr-FR');

  setStatus('Création du plan de localisation…');

  // ---------------- Bandeau de titre ----------------
  const headH=26;
  doc.setFillColor(...RP.ink);doc.rect(0,0,pw,headH,'F');
  doc.setDrawColor(...RP.accent);doc.setLineWidth(1.1);doc.line(0,headH+0.55,pw,headH+0.55);
  doc.setFont(RP_F,'normal');doc.setFontSize(6.4);doc.setTextColor(126,196,175);
  rpTracked(doc,'COMPTE-RENDU PHOTOGRAPHIQUE',M,9.4,0.9);
  doc.setFont(RP_F,'bold');doc.setFontSize(16);doc.setTextColor(255,255,255);
  doc.text(projectTitle,M,18.4);
  doc.setFont(RP_F,'normal');doc.setFontSize(7.4);doc.setTextColor(172,181,190);
  doc.text('Plan de localisation des prises de vue',M,23.2);
  rpMetaBlock(doc,[['ÉDITÉ LE',today],['PRISES DE VUE',String(points.length)]],pw-M,11,18.4);

  // ---------------- Géométrie : carte + cartouche ----------------
  const topY=headH+9;
  const panelW=64,gapPC=6;
  const mapX=M,mapY=topY;
  const mapW=pw-M*2-panelW-gapPC;
  const mapH=ph-16-topY-6;
  const panelX=pw-M-panelW,panelY=topY,panelH=mapH;

  let lonMin=Infinity,lonMax=-Infinity,latMin=Infinity,latMax=-Infinity;
  points.forEach(p=>{if(p.lon<lonMin)lonMin=p.lon;if(p.lon>lonMax)lonMax=p.lon;if(p.lat<latMin)latMin=p.lat;if(p.lat>latMax)latMax=p.lat;});
  if(lonMin===lonMax){lonMin-=0.001;lonMax+=0.001;}
  if(latMin===latMax){latMin-=0.001;latMax+=0.001;}
  const padLon=(lonMax-lonMin)*0.15,padLat=(latMax-latMin)*0.15;
  lonMin-=padLon;lonMax+=padLon;latMin-=padLat;latMax+=padLat;

  // Projection Web Mercator (comme un vrai fond de carte), étendue élargie pour
  // correspondre exactement au ratio du cadre : le fond IGN remplit tout le
  // cadre sans déformation.
  let [mxMin,myMin]=toWebMercator(lonMin,latMin);
  let [mxMax,myMax]=toWebMercator(lonMax,latMax);
  const boxRatio=mapW/mapH;
  if((mxMax-mxMin)/(myMax-myMin)<boxRatio){
    const newSpanX=(myMax-myMin)*boxRatio,cx=(mxMin+mxMax)/2;
    mxMin=cx-newSpanX/2;mxMax=cx+newSpanX/2;
  }else{
    const newSpanY=(mxMax-mxMin)/boxRatio,cy=(myMin+myMax)/2;
    myMin=cy-newSpanY/2;myMax=cy+newSpanY/2;
  }
  // Emprise minimale, imposée par la finesse réelle de la donnée. Trois photos
  // prises à quelques mètres l'une de l'autre donnaient une emprise de quelques
  // mètres : cadrée au plus juste, elle ne contient qu'une poignée de pixels
  // d'orthophoto (18 x 13 px relevés sur un cas réel) que le lecteur PDF étire
  // ensuite sur 20 cm de papier — une bouillie colorée. L'orthophoto plafonne à
  // 20 cm/px, on ne peut donc pas gagner en finesse ; en revanche on peut cesser
  // de grossir le vide. Élargir jusqu'à RP_DPI_FLOOR donne un plan net qui, en
  // prime, montre les abords — la route, le bâtiment voisin, l'entrée de
  // parcelle — c'est-à-dire ce qui permet de retrouver le lieu.
  const minSpanX=(mapW/25.4*RP_DPI_FLOOR)*(2*Math.PI*6378137/(256*Math.pow(2,IGN_ORTHO_ZMAX)));
  if(mxMax-mxMin<minSpanX){
    const k=minSpanX/(mxMax-mxMin);
    const cxm=(mxMin+mxMax)/2,cym=(myMin+myMax)/2;
    const hw=(mxMax-mxMin)*k/2,hh=(myMax-myMin)*k/2;
    mxMin=cxm-hw;mxMax=cxm+hw;myMin=cym-hh;myMax=cym+hh;
  }
  const [lonMinAdj,latMinAdj]=fromWebMercator(mxMin,myMin);
  const [lonMaxAdj,latMaxAdj]=fromWebMercator(mxMax,myMax);

  // Zoom calculé pour fournir au moins la résolution d'impression visée — jamais
  // dégradé pour économiser des tuiles.
  //
  // Le plafond est le niveau 19, mesuré et non supposé : un sondage du WMTS sur
  // 65 points terrestres de métropole donne 100 % de couverture au niveau 15,
  // 98,5 % au 17, 96,9 % au 19 — et 0 % aux niveaux 20 et 21, absents partout.
  // Viser plus haut ne rapportait donc aucun détail : cela faisait seulement
  // demander deux dalles complètes vouées au 404 avant de retomber sur le 19,
  // soit une centaine de requêtes inutiles et l'attente correspondante à chaque
  // compte-rendu. La résolution native de la BD ORTHO (20 cm/px) est le vrai
  // plafond ; sur un chantier de quelques dizaines de mètres, le fond de plan
  // sera forcément peu défini, aucun réglage ne peut inventer la donnée.
  //
  // Le plancher est lui aussi calculé, et non figé à un niveau donné : un
  // plancher fixe imposait le zoom 17 même sur une emprise de plusieurs
  // kilomètres, où le niveau 16 suffit largement — la mosaïque dépassait alors
  // le budget de tuiles et la page repartait sans aucun fond de carte, alors
  // qu'un niveau de moins l'aurait rendue nettement au-delà du nécessaire.
  const zoomFor=dpi=>Math.max(
    pickZoomForSpan(mxMax-mxMin,mapW/25.4*dpi,6,IGN_ORTHO_ZMAX),
    pickZoomForSpan(myMax-myMin,mapH/25.4*dpi,6,IGN_ORTHO_ZMAX)
  );

  setStatus('Recherche d\'une connexion pour le fond de carte IGN…');
  const basemap=await rpFetchPlanBasemap(lonMinAdj,latMinAdj,lonMaxAdj,latMaxAdj,
    zoomFor(RP_DPI_FETCH),200,zoomFor(RP_DPI_MIN));
  setStatus('Création des cartes de situation…');
  // Hauteur des encarts déduite de la place réellement libre plutôt que fixée à
  // la main : tout le reste du cartouche (titres, légende, bloc de métadonnées)
  // est de hauteur constante, les encarts se partagent ce qui reste. Des valeurs
  // en dur se seraient chevauchées avec le bloc du bas à la première évolution
  // de la mise en page — ce qui venait d'arriver en agrandissant les encarts.
  const RP_META_H=20;
  const insetRoom=(panelH-RP_META_H-4)-51.1;
  const hDept=Math.max(22,Math.min(46,insetRoom*0.46));
  const hSit=Math.max(24,Math.min(52,insetRoom-hDept));
  const situation=await rpFetchSituation(panelW-10,hSit,mxMin,myMin,mxMax,myMax);
  const dept=await rpFetchDept(panelW-10,hDept,mxMin,myMin,mxMax,myMax);

  // ---------------- Carte ----------------
  // Pas de voile sur l'orthophoto : les repères ont leur propre halo et tout le
  // mobilier repose sur des plaques opaques, l'image reste donc fidèle.
  doc.setFillColor(...RP.panel);doc.rect(mapX,mapY,mapW,mapH,'F');
  if(basemap){
    setStatus('Préparation du fond de carte pour l\'impression…');
    // La retouche photographique ne vaut que pour une prise de vue aérienne :
    // accentuer et saturer un plan cartographique ne ferait qu'agresser des
    // aplats et des traits déjà nets.
    const img=basemap.photo?rpPrepareOrtho(basemap.img,mapW,mapH):rpFitRaster(basemap.img,mapW,mapH);
    doc.addImage(rpJpeg(img,basemap.photo?0.92:0.95),'JPEG',mapX,mapY,mapW,mapH);
  }
  doc.setDrawColor(...RP.ink);doc.setLineWidth(0.5);doc.rect(mapX,mapY,mapW,mapH,'S');

  function project(lon,lat){
    const [mx,my]=toWebMercator(lon,lat);
    return [mapX+(mx-mxMin)/(mxMax-mxMin)*mapW,mapY+(myMax-my)/(myMax-myMin)*mapH];
  }
  const projected=points.map(p=>{const [x,y]=project(p.lon,p.lat);return {x,y};});
  const labels=computeLabelLayout(projected,mapX,mapY,mapW,mapH);

  // Segment de rappel + point de position exacte, pour chaque prise de vue sans
  // exception : c'est ce point, et non le repère chiffré, qui donne la position.
  labels.forEach((l,i)=>{
    doc.setDrawColor(...RP.paper);doc.setLineWidth(0.85);
    doc.line(projected[i].x,projected[i].y,l.x,l.y);
    doc.setDrawColor(...RP.dataDark);doc.setLineWidth(0.3);
    doc.line(projected[i].x,projected[i].y,l.x,l.y);
    doc.setFillColor(...RP.paper);doc.circle(projected[i].x,projected[i].y,1.15,'F');
    doc.setFillColor(...RP.dataDark);doc.circle(projected[i].x,projected[i].y,0.62,'F');
  });
  points.forEach((p,i)=>rpMarker(doc,labels[i].x,labels[i].y,i+1,RP_MARK_R));

  rpNorthArrow(doc,mapX+11,mapY+12,6.4);
  rpScaleBar(doc,mapX+5,mapY+mapH-19,mxMax-mxMin,mapW);

  // Note de lecture + attribution, posées sous le cadre (hors de l'image).
  doc.setFont(RP_F,'normal');doc.setFontSize(6.6);doc.setTextColor(...RP.muted);
  doc.text('Les numéros renvoient aux fiches photographiques des pages suivantes.',mapX,mapY+mapH+4.3);
  // Le cadre vide du repli hors ligne doit s'expliquer de lui-même : sans cette
  // mention, le lecteur croit à un plan raté plutôt qu'à une absence de réseau.
  doc.text(basemap?'Fond de carte : IGN Géoplateforme — '+basemap.label
      :'Fond de carte indisponible (hors connexion) — positions relevées conservées',
    mapX+mapW,mapY+mapH+4.3,{align:'right'});
  doc.setTextColor(0);

  // ---------------- Cartouche ----------------
  doc.setFillColor(...RP.panel);doc.rect(panelX,panelY,panelW,panelH,'F');
  doc.setDrawColor(...RP.hair);doc.setLineWidth(0.35);doc.rect(panelX,panelY,panelW,panelH,'S');
  const cx0=panelX+5,cw0=panelW-10;
  let cy=panelY+8;

  // Du général au particulier : le département situe le chantier pour qui ne
  // connaît pas la commune, la vue rapprochée montre ses abords, le grand plan
  // ci-contre montre les prises de vue. Chaque encart répond à une question que
  // le précédent laisse ouverte.
  if(dept){
    cy=rpLabel(doc,'Localisation',cx0,cy,cw0);
    const p=rpDrawInset(doc,cx0,cy,cw0,hDept,dept);
    rpDrawSitePoint(doc,p,(mxMin+mxMax)/2,(myMin+myMax)/2);
    cy+=hDept+7;
  }
  if(situation){
    cy=rpLabel(doc,'Situation générale',cx0,cy,cw0);
    const p=rpDrawInset(doc,cx0,cy,cw0,hSit,situation);
    rpDrawExtent(doc,p,mxMin,myMin,mxMax,myMax);
    cy+=hSit+7;
  }

  cy=rpLabel(doc,'Légende',cx0,cy,cw0);
  rpMarker(doc,cx0+3.6,cy+0.6,'1',RP_MARK_R);
  doc.setFont(RP_F,'normal');doc.setFontSize(6.8);doc.setTextColor(...RP.inkSoft);
  doc.text('Prise de vue photographique',cx0+9.4,cy+1.8);
  cy+=7.4;
  // Le repère étant toujours déporté, la légende doit dire où se lit la position.
  doc.setDrawColor(...RP.dataDark);doc.setLineWidth(0.3);
  doc.line(cx0+1.4,cy+0.9,cx0+6.2,cy+0.9);
  doc.setFillColor(...RP.paper);doc.circle(cx0+1.4,cy+0.9,1.15,'F');
  doc.setFillColor(...RP.dataDark);doc.circle(cx0+1.4,cy+0.9,0.62,'F');
  doc.setTextColor(...RP.inkSoft);
  doc.text('Position relevée, au bout du trait',cx0+9.4,cy+1.8);
  cy+=7.4;

  const metaH=RP_META_H;

  // Bloc de métadonnées, calé en bas du cartouche.
  const my0=panelY+panelH-metaH+5;
  doc.setDrawColor(...RP.hair);doc.setLineWidth(0.35);
  doc.line(cx0,my0-5,cx0+cw0,my0-5);
  doc.setFont(RP_F,'normal');doc.setFontSize(5.8);doc.setTextColor(...RP.muted);
  [
    'Coordonnées : WGS 84 (EPSG:4326)',
    basemap?'Fond : IGN Géoplateforme — '+basemap.label:'Fond de carte indisponible (hors connexion)',
    'Édité le '+today
  ].forEach((t,i)=>doc.text(t,cx0,my0+i*3.4));
  doc.setTextColor(0);

  // ---------------- Fiches photographiques ----------------
  // Grille strictement régulière : chaque fiche occupe la même hauteur quelle
  // que soit l'orientation de la photo (letterbox à l'intérieur d'un cadre
  // fixe). C'est ce qui donne une planche-contact propre plutôt qu'un
  // empilement irrégulier.
  const PW=210,PH=297,mp=14,gut=8,cols=2,rows=3;
  const cardW=(PW-mp*2-gut)/cols;
  const headBottom=mp+8;
  const availH=(PH-16)-headBottom;
  const cardH=(availH-gut*(rows-1))/rows;
  const capH=15,imgH=cardH-capH;
  const perPage=cols*rows;

  for(let i=0;i<points.length;i++){
    if(i%perPage===0){
      doc.addPage('a4','portrait');
      rpPhotoHeader(doc,PW,mp,projectTitle);
    }
    setStatus('Ajout des photos… '+(i+1)+'/'+points.length);
    const p=points[i];
    const k=i%perPage,r=Math.floor(k/cols),c=k%cols;
    const x=mp+c*(cardW+gut),y=headBottom+r*(cardH+gut);
    const {img,url}=await loadImageElement(p.blob);

    doc.setFillColor(...RP.panel);doc.rect(x,y,cardW,imgH,'F');
    const s=Math.min(cardW/img.naturalWidth,imgH/img.naturalHeight);
    const dw=img.naturalWidth*s,dh=img.naturalHeight*s;
    doc.addImage(img,'JPEG',x+(cardW-dw)/2,y+(imgH-dh)/2,dw,dh);
    doc.setFillColor(...RP.paper);doc.rect(x,y+imgH,cardW,capH,'F');
    doc.setDrawColor(...RP.hair);doc.setLineWidth(0.35);
    doc.rect(x,y,cardW,cardH,'S');
    doc.line(x,y+imgH,x+cardW,y+imgH);

    rpMarker(doc,x+6.5,y+imgH+7.6,i+1,3.7);
    doc.setFont(RP_F,'bold');doc.setFontSize(8.6);doc.setTextColor(...RP.ink);
    let t=String(p.displayName||'');
    const parts=doc.splitTextToSize(t,cardW-16);
    if(parts.length>1)t=parts[0].replace(/\s+\S*$/,'')+'…';else t=parts[0];
    doc.text(t,x+12.5,y+imgH+6.4);
    doc.setFont(RP_F,'normal');doc.setFontSize(6.3);doc.setTextColor(...RP.muted);
    doc.text('N '+p.lat.toFixed(5)+'    E '+p.lon.toFixed(5),x+12.5,y+imgH+11);
    doc.setTextColor(0);
    URL.revokeObjectURL(url);
  }

  // ---------------- Pied de page ----------------
  const total=doc.internal.getNumberOfPages();
  for(let i=1;i<=total;i++){
    doc.setPage(i);
    const w=doc.internal.pageSize.getWidth(),h=doc.internal.pageSize.getHeight();
    const m=w>250?M:mp;
    doc.setDrawColor(...RP.hair);doc.setLineWidth(0.3);
    doc.line(m,h-10,w-m,h-10);
    doc.setFont(RP_F,'normal');doc.setFontSize(6.5);doc.setTextColor(...RP.muted);
    doc.text(projectTitle,m,h-6);
    doc.text(i+' / '+total,w-m,h-6,{align:'right'});
    doc.setTextColor(0);
  }

  return doc;
}
