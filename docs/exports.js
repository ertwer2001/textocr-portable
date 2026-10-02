/* Local OOXML export. Load vendored JSZip before importing this module. */
const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};
const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain;charset=utf-8',
};
const FONT = 'Microsoft JhengHei';
const xml = value => String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const round = value => Math.round(Number(value));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const sum = values => values.reduce((a, b) => a + b, 0);
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

function color(value, fallback = '000000') {
  if (value == null) return fallback;
  if (Array.isArray(value)) {
    if (value.length < 3 || value.slice(0, 3).some(c => !Number.isFinite(c) || c < 0 || c > 255)) throw new Error('色彩資料無效。');
    return value.slice(0, 3).map(c => round(c).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  const result = String(value).replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(result)) throw new Error('色彩資料無效。');
  return result;
}
function box(value) {
  if (!Array.isArray(value) || value.length !== 4 || value.some(n => !Number.isFinite(n)) || value[2] < 0 || value[3] < 0) throw new Error('物件位置無效。');
  return value;
}
function inside(value, region) {
  const [x,y,w,h] = box(value), [l,t,rw,rh] = box(region);
  return x+w/2 >= l && x+w/2 <= l+rw && y+h/2 >= t && y+h/2 <= t+rh;
}
function pageSize(page) {
  if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0) throw new Error('頁面尺寸無效。');
  return [page.width, page.height];
}
function col(index) {
  let result = '';
  for (let n = index + 1; n; n = Math.floor((n-1)/26)) result = String.fromCharCode(65 + (n-1)%26) + result;
  return result;
}
function rels(items) {
  return HEADER + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + items.map(([id,type,target]) => `<Relationship Id="${xml(id)}" Type="${NS.r}/${type}" Target="${xml(target)}"/>`).join('') + '</Relationships>';
}
function contentTypes(overrides, defaults = {}) {
  return HEADER + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' + Object.entries({rels:'application/vnd.openxmlformats-package.relationships+xml',xml:'application/xml',...defaults}).map(([ext,type]) => `<Default Extension="${ext}" ContentType="${type}"/>`).join('') + overrides.map(([name,type]) => `<Override PartName="/${name}" ContentType="${type}"/>`).join('') + '</Types>';
}
async function zip(parts, onProgress) {
  if (!globalThis.JSZip) throw new Error('ZIP 元件尚未載入，請重新開啟網站。');
  const archive = new globalThis.JSZip();
  for (const [name,data] of Object.entries(parts)) archive.file(name, data, {compression:/\.(png|xlsx)$/.test(name)?'STORE':'DEFLATE'});
  return archive.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:6}}, metadata => onProgress?.({phase:'zip',percent:metadata.percent}));
}
function canvas(width,height) {
  const result = globalThis.OffscreenCanvas ? new OffscreenCanvas(round(width),round(height)) : document.createElement('canvas');
  result.width = round(width); result.height = round(height);
  return result;
}
function copyCanvas(source) {
  if (!source?.getContext) throw new Error('找不到原始圖片，請重新辨識。');
  const result = canvas(source.width,source.height);
  result.getContext('2d').drawImage(source,0,0);
  return result;
}
async function png(source) {
  if (!source) throw new Error('找不到原始圖片，請重新辨識。');
  const blob = source.convertToBlob ? await source.convertToBlob({type:'image/png'}) : await new Promise((resolve,reject) => source.toBlob(value => value ? resolve(value) : reject(new Error('圖片無法匯出。')),'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
function surroundingColor(ctx, value, width, height) {
  const [x,y,w,h] = value, points = [[x-2,y+h/2],[x+w+2,y+h/2],[x+w/2,y-2],[x+w/2,y+h+2]];
  const channels = [[],[],[]];
  for (const [px,py] of points) {
    const data = ctx.getImageData(clamp(round(px),0,width-1),clamp(round(py),0,height-1),1,1).data;
    for (let i=0;i<3;i++) channels[i].push(data[i]);
  }
  return '#' + color(channels.map(values => values.sort((a,b)=>a-b)[2]),'FFFFFF');
}
function erase(ctx, value, width, height, margin = 1) {
  const [x,y,w,h] = box(value);
  ctx.fillStyle = surroundingColor(ctx,value,width,height);
  ctx.fillRect(x-margin,y-margin,w+margin*2,h+margin*2);
}
function photos(page) { return page.analyses?.pictures || []; }
function editableLines(page) {
  return (page.lines || []).filter(line => !line.preserveImage && String(line.text ?? '').trim() && !photos(page).some(photo => inside(line.box,photo.box)));
}
function background(page) {
  const result = copyCanvas(page.backgroundCanvas || page.canvas);
  if (!page.backgroundCanvas) {
    const ctx = result.getContext('2d');
    for (const line of editableLines(page)) erase(ctx,line.box,result.width,result.height);
  }
  return result;
}
function lineFont(line) {
  const [, ,w,h] = box(line.box);
  const length = [...String(line.text)].reduce((n,c)=>n+(c.codePointAt(0)>255?1:.55),0);
  return clamp(Number(line.fontSize) || Math.min(h*1.1,w/Math.max(1,length)),4,200);
}
function pageText(page) { return String(page.editedText ?? page.text ?? (page.lines || []).map(line=>line.text).join('\n')); }

function tableData(value) {
  const table = value?.table || value?.data || value;
  if (!table?.rows?.length || !Array.isArray(table.rows[0]) || !table.rows[0].length) throw new Error('表格行列資料不完整。');
  const count = table.rows[0].length;
  if (table.rows.some(row=>!Array.isArray(row)||row.length!==count||row.some(value=>String(value??'').length>32767))) throw new Error('表格儲存格資料無效。');
  const widths = table.widths || table.column_widths_px || Array(count).fill(100);
  const heights = table.heights || table.row_heights_px || Array(table.rows.length).fill(24);
  if (widths.length!==count || heights.length!==table.rows.length || [...widths,...heights].some(n=>!Number.isFinite(n)||n<=0)) throw new Error('表格尺寸無效。');
  if (count>16384 || table.rows.length>1048576) throw new Error('表格超出 Excel 的行列限制。');
  const fills = table.fills || table.rows.map(row=>row.map(()=>'FFFFFF'));
  if (fills.length!==table.rows.length || fills.some(row=>row.length!==count)) throw new Error('表格底色資料不完整。');
  const merges = table.merges || [], occupied = new Map();
  for (const merge of merges) {
    if (!Array.isArray(merge)||merge.length!==4||merge.some(n=>!Number.isInteger(n))) throw new Error('合併儲存格資料無效。');
    const [r1,c1,r2,c2] = merge;
    if (r1<0||c1<0||r2<r1||c2<c1||r2>=table.rows.length||c2>=count) throw new Error('合併儲存格超出表格範圍。');
    for(let r=r1;r<=r2;r++) for(let c=c1;c<=c2;c++) {
      if(occupied.has(`${r},${c}`)) throw new Error('合併儲存格重疊。');
      occupied.set(`${r},${c}`,merge);
    }
  }
  return {...table,widths,heights,fills:fills.map(row=>row.map(fill=>color(fill,'FFFFFF'))),merges,occupied};
}
function tables(page) {
  const entries = page.tables?.length ? page.tables : page.analyses?.tables?.length ? page.analyses.tables : page.table ? [page.table] : [];
  return entries.map(item=>({box:item.box || item.table?.box || item.data?.box,table:tableData(item)}));
}
function workbookPages(pages) {
  const values=[],names=[],used=new Set();
  for(const page of pages) {
    let entries=tables(page).map(item=>item.table);
    if(!entries.length) {
      const rows=pageText(page).split('\n').map(text=>[text]);
      entries=[{rows,widths:[Math.min(1800,Math.max(180,Number(page.width)||640))],heights:rows.map(()=>24),fills:rows.map(()=>['FFFFFF']),merges:[]}];
    }
    for(let index=0;index<entries.length;index++) {
      const raw=`${page.name||'頁面'}${entries.length>1?` 表格${index+1}`:''}`;
      const base=raw.replace(/[\\/*?:\[\]\u0000-\u001F]/g,' ').replace(/^'+|'+$/g,'').trim()||'頁面';
      let suffix='',number=1,name;
      do {
        name=base.slice(0,31-suffix.length).replace(/[\uD800-\uDBFF]$/,'')+suffix;
        if(used.has(name.toLowerCase()))suffix=` (${++number})`;else break;
      }while(true);
      used.add(name.toLowerCase());names.push(name);values.push(entries[index]);
    }
  }
  return {values,names};
}
async function xlsx(tablesInput, numeric = false, sheetNames) {
  if (!tablesInput.length) throw new Error('沒有可確認行列的表格，請先辨識清楚的表格。');
  const data = tablesInput.map(tableData), colors = [...new Set(data.flatMap(table=>table.fills.flat()))];
  const fills = '<fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' + colors.map(c=>`<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`).join('');
  const fonts = ['000000','FFFFFF'].map(c=>`<font><sz val="10"/><color rgb="FF${c}"/><name val="${FONT}"/><family val="2"/></font>`).join('');
  const xfs = colors.map((c,i) => {
    const rgb = [0,2,4].map(n=>parseInt(c.slice(n,n+2),16)), dark = rgb[0]*299+rgb[1]*587+rgb[2]*114<128000;
    return `<xf numFmtId="49" fontId="${+dark}" fillId="${i+2}" borderId="0" xfId="0" applyAlignment="1" applyNumberFormat="1"><alignment vertical="center" wrapText="1"/></xf>`;
  });
  if (numeric) xfs.push('<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0"/>');
  const borders = ['left','right','top','bottom'].map(edge=>`<${edge} style="thin"><color rgb="FF000000"/></${edge}>`).join('');
  const parts = {'xl/styles.xml':HEADER+`<styleSheet xmlns="${NS.s}"><fonts count="2">${fonts}</fonts><fills count="${colors.length+2}">${fills}</fills><borders count="1"><border>${borders}<diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`};
  for (let index=0;index<data.length;index++) {
    const table = data[index];
    const columns = table.widths.map((width,c)=>`<col min="${c+1}" max="${c+1}" width="${clamp((width-5)/7,1,255).toFixed(3)}" customWidth="1"/>`).join('');
    const rows = table.rows.map((row,r)=>`<row r="${r+1}" ht="${Math.min(409,table.heights[r]*.75).toFixed(3)}" customHeight="1">`+row.map((value,c)=> {
      const merge = table.occupied.get(`${r},${c}`);
      if (merge && (r!==merge[0]||c!==merge[1])) value='';
      if (numeric && r>0 && c>0) {
        const series = numeric[c-1], style = colors.length+(series?.percent?1:0);
        if(value!==null&&value!==''&&(!Number.isFinite(value)||typeof value!=='number')) throw new Error('圖表只可使用明確數值。');
        return `<c r="${col(c)}${r+1}" t="n" s="${style}">${value===null||value===''?'':`<v>${value}</v>`}</c>`;
      }
      return `<c r="${col(c)}${r+1}" t="inlineStr" s="${colors.indexOf(table.fills[r][c])}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
    }).join('')+'</row>').join('');
    const merges = table.merges.length ? `<mergeCells count="${table.merges.length}">`+table.merges.map(([r1,c1,r2,c2])=>`<mergeCell ref="${col(c1)}${r1+1}:${col(c2)}${r2+1}"/>`).join('')+'</mergeCells>' : '';
    parts[`xl/worksheets/sheet${index+1}.xml`] = HEADER+`<worksheet xmlns="${NS.s}"><dimension ref="A1:${col(table.widths.length-1)}${table.rows.length}"/><sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews><cols>${columns}</cols><sheetData>${rows}</sheetData>${merges}</worksheet>`;
  }
  parts['xl/workbook.xml'] = HEADER+`<workbook xmlns="${NS.s}" xmlns:r="${NS.r}"><sheets>`+data.map((_,i)=>`<sheet name="${xml(sheetNames?.[i]||`表格${i+1}`)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')+'</sheets></workbook>';
  parts['xl/_rels/workbook.xml.rels'] = rels([...data.map((_,i)=>[`rId${i+1}`,'worksheet',`worksheets/sheet${i+1}.xml`]),[`rId${data.length+1}`,'styles','styles.xml']]);
  parts['_rels/.rels'] = rels([['rId1','officeDocument','xl/workbook.xml']]);
  parts['[Content_Types].xml'] = contentTypes([['xl/workbook.xml',MIME.xlsx+'.main+xml'],['xl/styles.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'],...data.map((_,i)=>[`xl/worksheets/sheet${i+1}.xml`,'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'])]);
  return zip(parts);
}

function wordSection(w,h) { return `<w:sectPr><w:type w:val="nextPage"/><w:pgSz w:w="${round(w*20)}" w:h="${round(h*20)}"/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`; }
function wordPicture(rel,w,h,id) {
  const cx=round(w*12700),cy=round(h*12700);
  return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="0" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="${id}" name="原稿圖形 ${id}"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="原稿圖形"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
}
function wordText(line,id,scale) {
  const [x,y,w,h] = line.box.map(n=>n*scale), size=lineFont(line)*scale;
  const style=`position:absolute;margin-left:${x.toFixed(3)}pt;margin-top:${Math.max(0,y-size*.22).toFixed(3)}pt;width:${Math.max(1,w).toFixed(3)}pt;height:${Math.max(h*1.8,size*1.8).toFixed(3)}pt;z-index:${id};mso-position-horizontal-relative:page;mso-position-vertical-relative:page`;
  return `<w:r><w:pict><v:shape id="text${id}" type="#_x0000_t202" style="${style}" filled="f" stroked="f"><v:textbox inset="0,0,0,0"><w:txbxContent><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${round(size*24)}" w:lineRule="exact"/><w:wordWrap w:val="0"/><w:snapToGrid w:val="0"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:eastAsia="${FONT}"/><w:sz w:val="${Math.max(2,round(size*2))}"/><w:color w:val="${color(line.color)}"/>${line.bold?'<w:b/>':''}<w:fitText w:val="${Math.max(20,round(w*20))}" w:id="${id}"/></w:rPr><w:t xml:space="preserve">${xml(line.text)}</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r>`;
}
async function docx(pages,mode,onProgress,preparePage,releasePage) {
  if(!['editable','text','image','original'].includes(mode)) throw new Error('未知的 Word 匯出模式。');
  if(mode==='editable'&&!pages.some(page=>editableLines(page).length)) throw new Error('沒有可編輯文字；請重新辨識，或明確選用原圖模式。');
  const parts={},body=[],relationships=[];let ident=1;
  if(mode==='text') {
    for(const page of pages) {
      try {
        await preparePage?.(page);
        for(const line of (`【${page.name||'圖片'}】\n`+pageText(page)+'\n').split('\n')) body.push(`<w:p><w:pPr><w:spacing w:after="80"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="${FONT}"/><w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">${xml(line)}</w:t></w:r></w:p>`);
      } finally {await releasePage?.(page);}
    }
    body.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>');
  } else for(let index=0;index<pages.length;index++) {
    const page=pages[index];
    try {
    await preparePage?.(page);
    const [pw,ph]=pageSize(page);let w=ph>=pw?595.28:841.89,h=w*ph/pw;
    const limit=Math.min(1,1584/Math.max(w,h));w*=limit;h*=limit;
    const rel=`rId${index+1}`,name=`page${index+1}.png`, imageMode=mode==='image'||mode==='original';
    const image=imageMode?page.canvas:background(page);
    try {parts[`word/media/${name}`]=await png(image);}
    finally {if(!imageMode){image.width=1;image.height=1;}}
    relationships.push([rel,'image',`media/${name}`]);
    let content=index===0?'<w:r><w:pict><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype></w:pict></w:r>':'';
    content+=wordPicture(rel,w,h,ident++);
    if(!imageMode) for(const line of editableLines(page)) content+=wordText(line,ident++,w/pw);
    body.push('<w:p><w:pPr><w:spacing w:after="0" w:line="20" w:lineRule="exact"/></w:pPr>'+content+'</w:p>');
    const section=wordSection(w,h);
    body.push(index===pages.length-1?section:'<w:p><w:pPr><w:spacing w:after="0" w:line="20" w:lineRule="exact"/>'+section+'</w:pPr></w:p>');
    onProgress?.({phase:'page',current:index+1,total:pages.length});await pause();
    } finally {await releasePage?.(page);}
  }
  parts['word/document.xml']=HEADER+`<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:a="${NS.a}" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.join('')}</w:body></w:document>`;
  parts['word/settings.xml']=HEADER+`<w:settings xmlns:w="${NS.w}"><w:displayBackgroundShape/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
  relationships.push([`rId${pages.length+1}`,'settings','settings.xml']);
  parts['word/_rels/document.xml.rels']=rels(relationships);parts['_rels/.rels']=rels([['rId1','officeDocument','word/document.xml']]);
  parts['[Content_Types].xml']=contentTypes([['word/document.xml',MIME.docx+'.main+xml'],['word/settings.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml']],{png:'image/png'});
  return zip(parts,onProgress);
}

const PPTNS=`xmlns:a="${NS.a}" xmlns:p="${NS.p}" xmlns:r="${NS.r}"`;
const GROUP='<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
function xfrm(rect,tag='a:xfrm',extra='') {const [x,y,w,h]=rect;return `<${tag}${extra}><a:off x="${round(x)}" y="${round(y)}"/><a:ext cx="${Math.max(1,round(w))}" cy="${Math.max(1,round(h))}"/></${tag}>`;}
function run(text,size,c='000000',bold=false) {return `<a:r><a:rPr lang="zh-TW" sz="${round(clamp(size*100,100,40000))}" b="${+bold}"><a:solidFill><a:srgbClr val="${color(c)}"/></a:solidFill><a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/><a:cs typeface="Arial"/></a:rPr><a:t xml:space="preserve">${xml(text)}</a:t></a:r>`;}
function paragraphs(text,size,c='000000',bold=false,align='l') {return String(text??'').split('\n').map(line=>`<a:p><a:pPr algn="${align}"><a:buNone/></a:pPr>${run(line,size,c,bold)}<a:endParaRPr lang="zh-TW" sz="${round(clamp(size*100,100,40000))}"/></a:p>`).join('');}
function picture(id,rect,rel,name) {return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${xml(name)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(rect)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;}
function textShape(id,rect,line,size) {return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="辨識文字 ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(rect)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs(line.text,size,line.color||'000000',!!line.bold)}</p:txBody></p:sp>`;}
function nativeShape(id,rect,item,scale) {
  const kind=item.kind||'rect';if(!['rect','diamond','roundRect','rightArrow'].includes(kind)) throw new Error('PPT 圖形種類不支援。');
  const fill=item.fill==null?'<a:noFill/>':`<a:solidFill><a:srgbClr val="${color(item.fill)}"/></a:solidFill>`;
  const stroke=`<a:ln w="${Math.max(1,round((item.width||1)*scale))}"><a:solidFill><a:srgbClr val="${color(item.line||item.stroke)}"/></a:solidFill><a:prstDash val="solid"/></a:ln>`;
  const text=item.text?`<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs(item.text,(item.fontSize||item.font_size||16)*scale/12700,item.textColor||item.text_color||'000000',!!item.bold,'ctr')}</p:txBody>`:'';
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="可編輯圖形 ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(rect)}<a:prstGeom prst="${kind}"><a:avLst/></a:prstGeom>${fill}${stroke}</p:spPr>${text}</p:sp>`;
}
function connection(point,shapes) {
  let best=null;
  for(const item of shapes) {
    const [x,y,w,h]=item.box,anchors=[[x+w/2,y],[x,y+h/2],[x+w/2,y+h],[x+w,y+h/2]];
    anchors.forEach(([ax,ay],idx)=>{const distance=Math.hypot(ax-point[0],ay-point[1]);if(distance<=25&&(!best||distance<best.distance))best={id:item.id,idx,distance};});
  }
  return best;
}
function connector(id,item,rectMap,scale,shapes) {
  const values=[item.x1,item.y1,item.x2,item.y2];if(values.some(n=>!Number.isFinite(n)))throw new Error('PPT 連線位置無效。');
  const [x1,y1,x2,y2]=values,rect=rectMap([Math.min(x1,x2),Math.min(y1,y2),Math.abs(x2-x1),Math.abs(y2-y1)]);
  const start=connection([x1,y1],shapes),end=connection([x2,y2],shapes);
  const attached=(start?`<a:stCxn id="${start.id}" idx="${start.idx}"/>`:'')+(end?`<a:endCxn id="${end.id}" idx="${end.idx}"/>`:'');
  return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="可編輯連線 ${id}"/><p:cNvCxnSpPr>${attached}</p:cNvCxnSpPr><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrm(rect,'a:xfrm',` flipH="${+(x2<x1)}" flipV="${+(y2<y1)}"`)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="${Math.max(1,round((item.width||1)*scale))}"><a:solidFill><a:srgbClr val="${color(item.color)}"/></a:solidFill><a:prstDash val="solid"/>${item.arrow?'<a:tailEnd type="triangle"/>':''}</a:ln></p:spPr></p:cxnSp>`;
}
function nativeTable(id,rect,value,scale,page) {
  const table=tableData(value),[,,tw,th]=rect,wx=sum(table.widths),hy=sum(table.heights);
  const font=(page.lines||[]).filter(line=>table.box&&inside(line.box,table.box)).map(lineFont).sort((a,b)=>a-b);
  const size=(font.length?font[Math.floor(font.length/2)]:14)*scale/12700;
  const grid=table.widths.map(width=>`<a:gridCol w="${Math.max(1,round(width/wx*tw))}"/>`).join('');
  const rows=table.rows.map((row,r)=>`<a:tr h="${Math.max(1,round(table.heights[r]/hy*th))}">`+row.map((value,c)=> {
    const attrs=[],merge=table.occupied.get(`${r},${c}`);
    if(merge){const [r1,c1,r2,c2]=merge;if(r===r1&&r2>r1)attrs.push(`rowSpan="${r2-r1+1}"`);if(c===c1&&c2>c1)attrs.push(`gridSpan="${c2-c1+1}"`);if(c>c1)attrs.push('hMerge="1"');if(r>r1)attrs.push('vMerge="1"');if(r!==r1||c!==c1)value='';}
    const fill=table.fills[r][c],channels=[0,2,4].map(n=>parseInt(fill.slice(n,n+2),16)),fg=channels[0]*299+channels[1]*587+channels[2]*114<128000?'FFFFFF':'000000';
    const borders=['L','R','T','B'].map(edge=>`<a:ln${edge} w="9525"><a:solidFill><a:srgbClr val="808080"/></a:solidFill><a:prstDash val="solid"/></a:ln${edge}>`).join('');
    return `<a:tc ${attrs.join(' ')}><a:txBody><a:bodyPr lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs(value,size,fg,r===0)}</a:txBody><a:tcPr marL="25400" marR="25400" marT="12700" marB="12700">${borders}<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill></a:tcPr></a:tc>`;
  }).join('')+'</a:tr>').join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="可編輯表格 ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>${xfrm(rect,'p:xfrm')}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}
function numeric(value) {if(value!==null&&(typeof value!=='number'||!Number.isFinite(value)))throw new Error('圖表只可使用明確數值。');return value;}
function chartData(data) {
  if(!data.categories?.length||!data.series?.length)throw new Error('圖表缺少類別或明確數值。');
  for(const series of data.series){if(!['bar','line'].includes(series.type||'bar')||series.values?.length!==data.categories.length||!series.values.some(v=>v!==null))throw new Error('圖表系列資料不完整。');series.values.forEach(numeric);}
  return data;
}
function cache(values,num=false,format='General') {return `<c:${num?'numCache':'strCache'}>${num?`<c:formatCode>${format}</c:formatCode>`:''}<c:ptCount val="${values.length}"/>`+values.map((value,i)=>value===null?'':`<c:pt idx="${i}"><c:v>${xml(num?numeric(value):value)}</c:v></c:pt>`).join('')+`</c:${num?'numCache':'strCache'}>`;}
async function chartWorkbook(data) {
  const rows=[['類別',...data.series.map(s=>s.name||'')],...data.categories.map((category,r)=>[String(category),...data.series.map(s=>s.values[r])])];
  return xlsx([{rows,widths:Array(data.series.length+1).fill(140),heights:Array(rows.length).fill(24),fills:rows.map(row=>row.map(()=>'FFFFFF'))}],data.series,['Sheet1']);
}
function chartXml(input) {
  const data=chartData(input),groups=new Map(),plot=[];
  data.series.forEach((series,index)=>{const key=`${series.type||'bar'}:${+!!series.secondary}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push([series,index]);});
  for(const [key,members] of groups){const [kind,secondary]=key.split(':'),ids=secondary==='1'?[201,202]:[101,102];
    const seriesXml=members.map(([series,index])=>{
      const column=col(index+1),paint=color(series.color,'4472C4'),format=series.percent?'0.0%':'General';
      const tx=`<c:tx><c:strRef><c:f>Sheet1!$${column}$1</c:f>${cache([series.name||''])}</c:strRef></c:tx>`;
      const cat=`<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${data.categories.length+1}</c:f>${cache(data.categories)}</c:strRef></c:cat>`;
      const val=`<c:val><c:numRef><c:f>Sheet1!$${column}$2:$${column}$${data.categories.length+1}</c:f>${cache(series.values,true,format)}</c:numRef></c:val>`;
      return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>${tx}<c:spPr><a:solidFill><a:srgbClr val="${paint}"/></a:solidFill><a:ln w="25400"><a:solidFill><a:srgbClr val="${paint}"/></a:solidFill></a:ln></c:spPr>${kind==='line'?'<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>':''}${cat}${val}${kind==='line'?'<c:smooth val="0"/>':''}</c:ser>`;
    }).join('');
    const format=members.every(([s])=>s.percent)?'0.0%':'General';
    const labels=`<c:dLbls><c:numFmt formatCode="${format}" sourceLinked="0"/><c:dLblPos val="${kind==='line'?'t':'outEnd'}"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>`;
    plot.push(kind==='bar'?`<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${seriesXml}${labels}<c:gapWidth val="80"/><c:overlap val="0"/>${ids.map(id=>`<c:axId val="${id}"/>`).join('')}</c:barChart>`:`<c:lineChart><c:grouping val="standard"/>${seriesXml}${labels}<c:marker val="1"/><c:smooth val="0"/>${ids.map(id=>`<c:axId val="${id}"/>`).join('')}</c:lineChart>`);
  }
  for(const secondary of [false,true]){
    const members=data.series.filter(s=>!!s.secondary===secondary);if(!members.length)continue;
    const [cat,val]=secondary?[201,202]:[101,102],percent=members.every(s=>s.percent),bounds=percent&&members.every(s=>s.values.every(v=>v===null||(v>=0&&v<=1)))?'<c:max val="1"/><c:min val="0"/>':'';
    plot.push(`<c:catAx><c:axId val="${cat}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="${+secondary}"/><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="${val}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>`);
    plot.push(`<c:valAx><c:axId val="${val}"/><c:scaling><c:orientation val="minMax"/>${bounds}</c:scaling><c:delete val="0"/><c:axPos val="${secondary?'r':'l'}"/>${secondary?'':'<c:majorGridlines/>'}<c:numFmt formatCode="${percent?'0%':'General'}" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="${cat}"/><c:crosses val="${secondary?'max':'autoZero'}"/><c:crossBetween val="between"/></c:valAx>`);
  }
  const title=data.title?`<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/>${paragraphs(data.title,14,'000000',true)}</c:rich></c:tx><c:overlay val="0"/></c:title>`:'';
  return HEADER+`<c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><c:date1904 val="0"/><c:lang val="zh-TW"/><c:roundedCorners val="0"/><c:chart>${title}<c:autoTitleDeleted val="${data.title?0:1}"/><c:plotArea><c:layout/>${plot.join('')}</c:plotArea><c:legend><c:legendPos val="b"/><c:layout/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr><c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`;
}
function theme() {
  const colors={dk1:'000000',lt1:'FFFFFF',dk2:'202020',lt2:'F3F4F6',accent1:'4472C4',accent2:'ED7D31',accent3:'A5A5A5',accent4:'FFC000',accent5:'5B9BD5',accent6:'70AD47',hlink:'0563C1',folHlink:'954F72'};
  const solid='<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>',fonts=['major','minor'].map(kind=>`<a:${kind}Font><a:latin typeface="Arial"/><a:ea typeface="${FONT}"/><a:cs typeface="Arial"/></a:${kind}Font>`).join('');
  return HEADER+`<a:theme xmlns:a="${NS.a}" name="TextOCR"><a:themeElements><a:clrScheme name="TextOCR">${Object.entries(colors).map(([name,value])=>`<a:${name}><a:srgbClr val="${value}"/></a:${name}>`).join('')}</a:clrScheme><a:fontScheme name="TextOCR">${fonts}</a:fontScheme><a:fmtScheme name="TextOCR"><a:fillStyleLst>${solid.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${[9525,25400,38100].map(w=>`<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${solid}<a:prstDash val="solid"/></a:ln>`).join('')}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${solid.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}
async function pptx(pages,onProgress,preparePage,releasePage) {
  const [firstW,firstH]=pageSize(pages[0]),cw=12192000,ch=round(cw*firstH/firstW),parts={},overrides=[];let chartCount=0;
  parts['ppt/theme/theme1.xml']=theme();
  parts['ppt/slideMasters/slideMaster1.xml']=HEADER+`<p:sldMaster ${PPTNS}><p:cSld name="TextOCR"><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`;
  parts['ppt/slideMasters/_rels/slideMaster1.xml.rels']=rels([['rId1','slideLayout','../slideLayouts/slideLayout1.xml'],['rId2','theme','../theme/theme1.xml']]);
  parts['ppt/slideLayouts/slideLayout1.xml']=HEADER+`<p:sldLayout ${PPTNS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  parts['ppt/slideLayouts/_rels/slideLayout1.xml.rels']=rels([['rId1','slideMaster','../slideMasters/slideMaster1.xml']]);
  for(let index=0;index<pages.length;index++){
    const page=pages[index];
    try {
    await preparePage?.(page);
    const [pw,ph]=pageSize(page),scale=Math.min(cw/pw,ch/ph),ox=(cw-pw*scale)/2,oy=(ch-ph*scale)/2,rectMap=([x,y,w,h])=>[ox+x*scale,oy+y*scale,w*scale,h*scale];
    const analysis=page.analyses||{},nativeTables=tables(page),charts=analysis.charts||[],shapes=analysis.shapes||[],lines=analysis.lines||[],pictures=photos(page);
    const bg=background(page),ctx=bg.getContext('2d');
    for(const item of [...nativeTables,...charts,...shapes]) if(item.box) erase(ctx,item.box,bg.width,bg.height,2);
    for(const item of lines){const margin=Math.max(2,(item.width||1)*2);erase(ctx,[Math.min(item.x1,item.x2),Math.min(item.y1,item.y2),Math.abs(item.x2-item.x1),Math.abs(item.y2-item.y1)],bg.width,bg.height,margin);}
    for(const photo of pictures) erase(ctx,photo.box,bg.width,bg.height,0);
    const num=index+1,relationships=[['rId1','slideLayout','../slideLayouts/slideLayout1.xml'],['rId2','image',`../media/background${num}.png`]],objects=[picture(2,rectMap([0,0,pw,ph]),'rId2','原稿圖形背景')];let id=3,native=0;
    try {parts[`ppt/media/background${num}.png`]=await png(bg);}
    finally {bg.width=1;bg.height=1;}
    for(let p=0;p<pictures.length;p++){
      const photo=pictures[p];let crop=photo.canvas;
      if(!crop){const [x,y,w,h]=box(photo.box);crop=canvas(w,h);crop.getContext('2d').drawImage(page.canvas,x,y,w,h,0,0,w,h);}
      try {parts[`ppt/media/photo${num}-${p+1}.png`]=await png(crop);}
      finally {if(!photo.canvas){crop.width=1;crop.height=1;}}
      const rid=`rId${relationships.length+1}`;relationships.push([rid,'image',`../media/photo${num}-${p+1}.png`]);objects.push(picture(id++,rectMap(box(photo.box)),rid,`原圖照片 ${p+1}`));
    }
    const shapeLinks=[];
    for(const item of shapes){shapeLinks.push({id,box:box(item.box)});objects.push(nativeShape(id++,rectMap(item.box),item,scale));native++;}
    for(const item of lines){objects.push(connector(id++,item,rectMap,scale,shapeLinks));native++;}
    for(const item of nativeTables){const bounds=item.box||item.table.box;if(!bounds)throw new Error('表格缺少位置。');objects.push(nativeTable(id++,rectMap(box(bounds)),{...item.table,box:bounds},scale,page));native++;}
    for(const item of charts){chartData(item);chartCount++;parts[`ppt/charts/chart${chartCount}.xml`]=chartXml(item);parts[`ppt/embeddings/chart${chartCount}.xlsx`]=await chartWorkbook(item);parts[`ppt/charts/_rels/chart${chartCount}.xml.rels`]=rels([['rId1','package',`../embeddings/chart${chartCount}.xlsx`]]);overrides.push([`ppt/charts/chart${chartCount}.xml`,'application/vnd.openxmlformats-officedocument.drawingml.chart+xml']);const rid=`rId${relationships.length+1}`;relationships.push([rid,'chart',`../charts/chart${chartCount}.xml`]);objects.push(`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="可編輯圖表 ${id++}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>${xfrm(rectMap(box(item.box)),'p:xfrm')}<a:graphic><a:graphicData uri="${NS.c}"><c:chart xmlns:c="${NS.c}" r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`);native++;}
    const excluded=[...nativeTables.map(item=>item.box||item.table.box),...charts.map(item=>item.box),...shapes.filter(item=>item.text).map(item=>item.box),...pictures.map(item=>item.box)].filter(Boolean);
    for(const line of editableLines(page)){if(excluded.some(bounds=>inside(line.box,bounds)))continue;const size=lineFont(line),[x,y,w,h]=box(line.box);objects.push(textShape(id++,rectMap([x,y-size*.15,w,Math.max(h+size*.3,size*1.1)]),line,size*scale/12700));native++;}
    if(!native)throw new Error(`「${page.name||num}」沒有可編輯文字或物件；不能將全頁圖片當成可編輯 PPT。`);
    parts[`ppt/slides/slide${num}.xml`]=HEADER+`<p:sld ${PPTNS}><p:cSld><p:spTree>${GROUP}${objects.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    parts[`ppt/slides/_rels/slide${num}.xml.rels`]=rels(relationships);overrides.push([`ppt/slides/slide${num}.xml`,'application/vnd.openxmlformats-officedocument.presentationml.slide+xml']);onProgress?.({phase:'page',current:num,total:pages.length});await pause();
    } finally {await releasePage?.(page);}
  }
  parts['ppt/presentation.xml']=HEADER+`<p:presentation ${PPTNS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${pages.map((_,i)=>`<p:sldId id="${256+i}" r:id="rId${i+2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${cw}" cy="${ch}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`;
  parts['ppt/_rels/presentation.xml.rels']=rels([['rId1','slideMaster','slideMasters/slideMaster1.xml'],...pages.map((_,i)=>[`rId${i+2}`,'slide',`slides/slide${i+1}.xml`])]);parts['_rels/.rels']=rels([['rId1','officeDocument','ppt/presentation.xml']]);
  overrides.push(['ppt/presentation.xml',MIME.pptx+'.main+xml'],['ppt/slideMasters/slideMaster1.xml','application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml'],['ppt/slideLayouts/slideLayout1.xml','application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml'],['ppt/theme/theme1.xml','application/vnd.openxmlformats-officedocument.theme+xml']);
  parts['[Content_Types].xml']=contentTypes(overrides,{png:'image/png',xlsx:MIME.xlsx});return zip(parts,onProgress);
}

/** pages are already selected, in their intended original order. No uploads occur. */
export async function exportDocument(kind,pages,{mode='editable',onProgress,preparePage,releasePage}={}) {
  if(!MIME[kind])throw new Error('未知的匯出格式。');
  if(!Array.isArray(pages)||!pages.length)throw new Error('請先選取已完成辨識的圖片或頁面。');
  if(kind==='txt')return new Blob(['\uFEFF',pages.map(page=>`【${page.name||'圖片'}】\n${pageText(page)}\n`).join('\n')],{type:MIME.txt});
  let bytes;
  if(kind==='docx')bytes=await docx(pages,mode,onProgress,preparePage,releasePage);
  if(kind==='xlsx'){const found=workbookPages(pages);onProgress?.({phase:'tables',current:found.values.length,total:pages.length});bytes=await xlsx(found.values,false,found.names);}
  if(kind==='pptx')bytes=await pptx(pages,onProgress,preparePage,releasePage);
  onProgress?.({phase:'done',current:pages.length,total:pages.length});
  return new Blob([bytes],{type:MIME[kind]});
}
