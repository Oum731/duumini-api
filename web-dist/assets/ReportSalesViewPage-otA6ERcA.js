import{j as e,L as B,du as W,dv as H}from"./index-KGU1czHf.js";import{c as O,r as l,L as V}from"./router-CeO0rlEc.js";import{b as Z,p as q}from"./reports-C-Dfynb2.js";import"./react-Bzgz95E1.js";function w(o){if(!o)return"—";const d=new Date(o);return Number.isNaN(d.getTime())?String(o):String(o).length<=10?d.toLocaleDateString("fr-FR"):d.toLocaleString("fr-FR")}function _(o){return o?.response?.data?.error||o?.message||"Erreur"}function a(o,d="MAD"){return new Intl.NumberFormat("fr-FR",{style:"currency",currency:d,maximumFractionDigits:2}).format(Number(o||0))}function m(o){const d=Number(o);return Number.isFinite(d)?d:0}function X(){const{id:o}=O(),d=Number(o),[C,z]=l.useState(!1),[t,k]=l.useState(null),[F,$]=l.useState(null),[u,h]=l.useState(null),M=l.useRef(null);l.useEffect(()=>{if(!Number.isFinite(d)||d<=0){$("ID invalide"),k(null);return}let r=!0;return(async()=>{z(!0),$(null);try{const i=await Z(d);if(!r)return;k(i||null)}catch(i){if(!r)return;k(null),$(_(i))}finally{if(!r)return;z(!1)}})(),()=>{r=!1}},[d]);const s=l.useMemo(()=>q(t?.details_json),[t]),f=l.useMemo(()=>Array.isArray(s?.payment_breakdown)?s.payment_breakdown:[],[s]),g=l.useMemo(()=>m(s?.gross_items_amount),[s]),b=l.useMemo(()=>m(s?.admin_discount_amount),[s]),p=l.useMemo(()=>{const r=m(s?.net_items_amount);if(r>0)return r;const i=m(t?.items_amount);return i>0?i:Math.max(0,g-b)},[s,t,g,b]),x=l.useMemo(()=>{const r=m(s?.paid_amount);return r>0?r:f.length?f.reduce((i,n)=>i+m(n?.paid_amount),0):0},[s,f]),N=l.useMemo(()=>{const r=m(s?.remaining_amount);if(r>0)return r;const n=m(t?.total_amount)-x;return n>0?n:0},[s,t,x]),v=l.useMemo(()=>m(t?.delivery_amount),[t]),y=l.useMemo(()=>p,[p]),R=l.useMemo(()=>{const r=m(t?.total_amount);return r>0?r:p+v},[t,p,v]),L=l.useMemo(()=>t?["DUUMINI - Rapport de ventes","",`Réf : #${t.id}`,`Type : ${t.period_type}`,`Devise : ${t.currency}`,`Début : ${w(t.period_start)}`,`Fin : ${w(t.period_end)}`,"","Résumé des ventes",`- Nombre de commandes : ${t.orders_count??0}`,`- Montant produits brut : ${a(g,t.currency)}`,`- Réduction admin : ${a(b,t.currency)}`,`- Produits nets : ${a(p,t.currency)}`,`- Livraison : ${a(v,t.currency)}`,`- Total ventes : ${a(y,t.currency)}`,`- Total global : ${a(R,t.currency)}`,"","Résumé financier",`- Commission Duumini : ${a(t.duumini_commission,t.currency)}`,`- Somme payée : ${a(x,t.currency)}`,`- Reste à payer : ${a(N,t.currency)}`,"","Merci d’utiliser Duumini"].join(`
`):"",[t,g,b,p,v,y,R,x,N]),j=()=>t?`duumini-rapport-${t.id}.png`:"duumini-rapport.png",A=r=>{const i=r.getBoundingClientRect(),n=Math.max(Math.ceil(r.scrollWidth||0),Math.ceil(r.offsetWidth||0),Math.ceil(r.clientWidth||0),Math.ceil(i.width||0),760),c=Math.max(Math.ceil(r.scrollHeight||0),Math.ceil(r.offsetHeight||0),Math.ceil(r.clientHeight||0),Math.ceil(i.height||0));return{width:n,height:c}},S=async()=>{const r=M.current;if(!r)throw new Error("Zone du reçu introuvable.");const{width:i,height:n}=A(r),c=await H(r,{cacheBust:!0,pixelRatio:2,backgroundColor:"#ffffff",canvasWidth:i,canvasHeight:n,width:i,height:n,skipFonts:!1,style:{width:`${i}px`,height:`${n}px`,margin:"0",transform:"none"}});if(!c)throw new Error("Impossible de générer l'image du reçu.");return c},T=async()=>{const r=M.current;if(!r)throw new Error("Zone du reçu introuvable.");const{width:i,height:n}=A(r);return await W(r,{cacheBust:!0,pixelRatio:2,backgroundColor:"#ffffff",canvasWidth:i,canvasHeight:n,width:i,height:n,skipFonts:!1,style:{width:`${i}px`,height:`${n}px`,margin:"0",transform:"none"}})},D=(r,i)=>{const n=URL.createObjectURL(r),c=document.createElement("a");c.href=n,c.download=i,document.body.appendChild(c),c.click(),c.remove(),setTimeout(()=>URL.revokeObjectURL(n),1500)},E=async()=>{if(t)try{h("print");const r=await T(),i=window.open("","_blank","width=1000,height=1400");if(!i)throw new Error("La fenêtre d'impression a été bloquée.");i.document.open(),i.document.write(`
        <!doctype html>
        <html>
          <head>
            <title>Rapport #${t.id}</title>
            <meta charset="utf-8" />
            <style>
              @page {
                size: A4 portrait;
                margin: 10mm;
              }

              * {
                box-sizing: border-box;
              }

              html, body {
                margin: 0;
                padding: 0;
                background: #fff;
                width: 100%;
                height: 100%;
              }

              body {
                display: flex;
                align-items: flex-start;
                justify-content: center;
              }

              .page {
                width: 190mm;
                height: 277mm;
                display: flex;
                align-items: flex-start;
                justify-content: center;
                overflow: hidden;
                margin: 0 auto;
              }

              img {
                display: block;
                max-width: 190mm;
                max-height: 277mm;
                width: auto;
                height: auto;
                object-fit: contain;
                margin: 0 auto;
                page-break-inside: avoid;
              }

              @media print {
                html, body {
                  background: #fff !important;
                  width: 100% !important;
                  height: 100% !important;
                }

                .page {
                  width: 190mm !important;
                  height: 277mm !important;
                  overflow: hidden !important;
                }

                img {
                  max-width: 190mm !important;
                  max-height: 277mm !important;
                  width: auto !important;
                  height: auto !important;
                  object-fit: contain !important;
                }
              }
            </style>
          </head>
          <body>
            <div class="page">
              <img id="receipt-image" src="${r}" alt="Rapport de ventes" />
            </div>

            <script>
              const img = document.getElementById("receipt-image");
              img.onload = () => {
                window.focus();
                setTimeout(() => {
                  window.print();
                  setTimeout(() => window.close(), 250);
                }, 180);
              };
            <\/script>
          </body>
        </html>
      `),i.document.close()}catch(r){alert(_(r))}finally{h(null)}},I=async()=>{if(t)try{h("share");const r=await S(),i=new File([r],j(),{type:"image/png"}),n=window.location.href;if(typeof navigator<"u"&&"share"in navigator&&"canShare"in navigator&&navigator.canShare?.({files:[i]})){await navigator.share({title:`Rapport de ventes #${t.id}`,text:`Rapport de ventes Duumini #${t.id}`,files:[i]});return}if(navigator.share){await navigator.share({title:`Rapport de ventes #${t.id}`,text:`${L}

${n}`,url:n});return}D(r,j()),alert("Image du rapport téléchargée.")}catch(r){if(r?.name!=="AbortError")try{const i=await S();D(i,j()),alert("Partage non supporté ici. Image du rapport téléchargée.")}catch{alert(_(r))}}finally{h(null)}},P=async()=>{if(t)try{h("wa");const r=await S(),i=new File([r],j(),{type:"image/png"});if(typeof navigator<"u"&&"share"in navigator&&"canShare"in navigator&&navigator.canShare?.({files:[i]})){await navigator.share({title:`Rapport de ventes #${t.id}`,text:`Rapport de ventes Duumini #${t.id}`,files:[i]});return}D(r,j());const c=`Rapport de ventes Duumini #${t.id}
L'image du reçu a été téléchargée. Joignez-la dans WhatsApp.

${window.location.href}`,U=`https://wa.me/?text=${encodeURIComponent(c)}`;window.open(U,"_blank","noopener,noreferrer")}catch(r){alert(_(r))}finally{h(null)}};return e.jsxs("div",{className:"container py-3 report-page-root",children:[e.jsx("style",{children:`
          .report-board {
            width: 760px;
            max-width: 760px;
            min-width: 760px;
            margin: 0 auto;
          }

          .report-card {
            position: relative;
            background:
              radial-gradient(circle at top right, rgba(255,193,7,.10), transparent 24%),
              linear-gradient(180deg, #ffffff 0%, #fffdfa 100%);
            border: 1px solid #efe7d6;
            border-radius: 20px;
            box-shadow:
              0 12px 28px rgba(17, 24, 39, .06),
              0 2px 8px rgba(17, 24, 39, .04);
            overflow: hidden;
            isolation: isolate;
          }

          .report-card::before {
            content: "";
            position: absolute;
            inset: 0 auto 0 0;
            width: 5px;
            background: linear-gradient(180deg, #f4b400 0%, #f59e0b 45%, #111827 100%);
          }

          .report-body {
            padding: 14px 16px 12px 18px;
          }

          .report-header {
            display: grid;
            grid-template-columns: 1.1fr .9fr;
            gap: 10px;
            align-items: center;
            margin-bottom: 10px;
          }

          .report-brand-side {
            display: flex;
            align-items: center;
            gap: 10px;
            min-width: 0;
          }

          .report-logo-wrap {
            width: 64px;
            height: 64px;
            border-radius: 16px;
            background: linear-gradient(180deg, #fff8e1 0%, #ffffff 100%);
            border: 1px solid #f5e6b2;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 6px 16px rgba(245, 158, 11, .10);
            flex-shrink: 0;
          }

          .report-logo {
            width: 46px;
            height: 46px;
            object-fit: contain;
            border-radius: 10px;
          }

          .report-kicker {
            font-size: 10px;
            font-weight: 800;
            letter-spacing: .16em;
            color: #b45309;
            text-transform: uppercase;
            margin-bottom: 2px;
          }

          .report-title {
            font-size: 26px;
            line-height: 1.02;
            font-weight: 900;
            color: #111827;
            margin-bottom: 4px;
          }

          .report-subtitle {
            color: #6b7280;
            font-size: 12px;
            line-height: 1.35;
            max-width: 430px;
          }

          .report-header-side {
            display: flex;
            flex-direction: column;
            gap: 8px;
          }

          .report-ref-box,
          .report-mini-box {
            border: 1px solid #eee6d7;
            background: #fffdf8;
            border-radius: 12px;
            padding: 9px 10px;
          }

          .report-ref-id {
            font-size: 16px;
            font-weight: 900;
            color: #111827;
            line-height: 1.1;
          }

          .report-ref-meta {
            color: #6b7280;
            font-size: 10px;
            margin-top: 3px;
            line-height: 1.3;
          }

          .report-badges {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
          }

          .report-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-height: 24px;
            padding: 4px 9px;
            border-radius: 999px;
            background: #111827;
            color: #fff;
            font-size: 9px;
            font-weight: 800;
            letter-spacing: .04em;
            text-transform: uppercase;
          }

          .report-badge-soft {
            background: #fff7ed;
            color: #c2410c;
            border: 1px solid #fed7aa;
          }

          .report-top-stats {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 8px;
            margin-bottom: 10px;
          }

          .stat-box {
            background: linear-gradient(180deg, #ffffff 0%, #fffaf0 100%);
            border: 1px solid #f1e7d3;
            border-radius: 12px;
            padding: 9px 10px;
          }

          .stat-label {
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: .06em;
            color: #6b7280;
            margin-bottom: 4px;
            font-weight: 800;
          }

          .stat-value {
            font-size: 18px;
            font-weight: 900;
            color: #111827;
            line-height: 1.08;
            word-break: break-word;
          }

          .report-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
          }

          .section-card {
            border: 1px solid #eff2f5;
            background: #fff;
            border-radius: 13px;
            padding: 10px 10px 7px;
            box-shadow: 0 2px 6px rgba(17, 24, 39, .03);
            min-width: 0;
          }

          .section-card.span-2 {
            grid-column: 1 / -1;
          }

          .section-title {
            font-size: 10px;
            font-weight: 900;
            text-transform: uppercase;
            letter-spacing: .08em;
            color: #111827;
            margin-bottom: 6px;
          }

          .line-row {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 8px;
            padding: 4px 0;
            border-bottom: 1px dashed #edf0f2;
          }

          .line-row:last-child {
            border-bottom: 0;
          }

          .line-label {
            font-size: 12px;
            color: #4b5563;
            line-height: 1.3;
            word-break: break-word;
            overflow-wrap: anywhere;
            flex: 1;
            min-width: 0;
          }

          .line-value {
            font-size: 12px;
            font-weight: 800;
            color: #111827;
            text-align: right;
            line-height: 1.3;
            word-break: break-word;
            overflow-wrap: anywhere;
            flex-shrink: 0;
            max-width: 50%;
          }

          .line-value.good {
            color: #047857;
          }

          .line-value.warn {
            color: #b45309;
          }

          .grand-total {
            margin-top: 6px;
            padding: 8px 10px;
            border-radius: 13px;
            background: linear-gradient(135deg, #111827 0%, #1f2937 100%);
            color: #fff;
          }

          .grand-total .line-row {
            border-bottom-color: rgba(255,255,255,.12);
          }

          .grand-total .line-label,
          .grand-total .line-value {
            color: #fff;
            font-size: 14px;
            font-weight: 900;
          }

          .payment-table {
            width: 100%;
            border-collapse: collapse;
          }

          .payment-table th,
          .payment-table td {
            padding: 5px 0;
            border-bottom: 1px dashed #edf0f2;
            font-size: 12px;
          }

          .payment-table th {
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: .06em;
            color: #6b7280;
            text-align: left;
            font-weight: 800;
          }

          .payment-table td:last-child,
          .payment-table th:last-child {
            text-align: right;
            font-weight: 800;
            color: #111827;
          }

          .payment-table tr:last-child td {
            border-bottom: 0;
          }

          .footer-note {
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px dashed #d7dce2;
            color: #6b7280;
            font-size: 11px;
            text-align: center;
            line-height: 1.35;
          }

          .receipt-actions .btn {
            border-radius: 12px;
            font-weight: 700;
          }

          @media (max-width: 991.98px) {
            .report-board {
              width: 100%;
              max-width: 100%;
              min-width: 0;
            }

            .report-header,
            .report-grid,
            .report-top-stats {
              grid-template-columns: 1fr;
            }

            .report-title {
              font-size: 24px;
            }

            .stat-value {
              font-size: 17px;
            }
          }

          @media print {
            .no-print {
              display: none !important;
            }
          }
        `}),e.jsxs("div",{className:"d-flex align-items-center justify-content-between gap-2 flex-wrap mb-3 no-print",children:[e.jsxs("div",{children:[e.jsx("h2",{className:"mb-0",children:"Rapport imprimable"}),e.jsx("div",{className:"text-muted small",children:"Reçu de ventes Duumini"})]}),e.jsxs("div",{className:"d-flex gap-2 flex-wrap receipt-actions",children:[e.jsx(V,{className:"btn btn-outline-secondary",to:"/admin/reports/sales",children:"Retour"}),e.jsx("button",{className:"btn btn-outline-dark",onClick:I,disabled:!t||!!u,children:u==="share"?"Préparation...":"Partager"}),e.jsx("button",{className:"btn btn-success",onClick:P,disabled:!t||!!u,children:u==="wa"?"Préparation...":"WhatsApp"}),e.jsx("button",{className:"btn btn-primary",onClick:E,disabled:!t||!!u,children:u==="print"?"Préparation...":"Imprimer"})]})]}),C&&e.jsx(B,{}),F&&e.jsx("div",{className:"alert alert-danger",children:F}),!!t&&e.jsx("div",{className:"report-board",children:e.jsx("div",{ref:M,className:"report-card",children:e.jsxs("div",{className:"report-body",children:[e.jsxs("div",{className:"report-header",children:[e.jsxs("div",{className:"report-brand-side",children:[e.jsx("div",{className:"report-logo-wrap",children:e.jsx("img",{src:"/logo.jpeg",alt:"Duumini",className:"report-logo",crossOrigin:"anonymous",onError:r=>{r.currentTarget.style.display="none"}})}),e.jsxs("div",{children:[e.jsx("div",{className:"report-kicker",children:"Duumini"}),e.jsx("div",{className:"report-title",children:"Rapport de ventes"}),e.jsx("div",{className:"report-subtitle",children:"Reçu récapitulatif des commandes finalisées et des montants associés."})]})]}),e.jsxs("div",{className:"report-header-side",children:[e.jsxs("div",{className:"report-ref-box",children:[e.jsxs("div",{className:"report-ref-id",children:["Réf. #",t.id]}),e.jsxs("div",{className:"report-ref-meta",children:["Créé le ",w(t.created_at||void 0)]})]}),e.jsx("div",{className:"report-mini-box",children:e.jsxs("div",{className:"report-badges",children:[e.jsx("span",{className:"report-badge",children:"Commandes DONE"}),e.jsx("span",{className:"report-badge report-badge-soft",children:t.currency}),e.jsx("span",{className:"report-badge report-badge-soft",children:t.period_type})]})})]})]}),e.jsxs("div",{className:"report-top-stats",children:[e.jsxs("div",{className:"stat-box",children:[e.jsx("div",{className:"stat-label",children:"Commandes"}),e.jsx("div",{className:"stat-value",children:t.orders_count??0})]}),e.jsxs("div",{className:"stat-box",children:[e.jsx("div",{className:"stat-label",children:"Total ventes"}),e.jsx("div",{className:"stat-value",children:a(y,t.currency)})]}),e.jsxs("div",{className:"stat-box",children:[e.jsx("div",{className:"stat-label",children:"Somme payée"}),e.jsx("div",{className:"stat-value",children:a(x,t.currency)})]}),e.jsxs("div",{className:"stat-box",children:[e.jsx("div",{className:"stat-label",children:"Reste à payer"}),e.jsx("div",{className:"stat-value",children:a(N,t.currency)})]})]}),e.jsxs("div",{className:"report-grid",children:[e.jsxs("div",{className:"section-card",children:[e.jsx("div",{className:"section-title",children:"Résumé des ventes"}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Nombre de commandes"}),e.jsx("div",{className:"line-value",children:t.orders_count??0})]}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Montant produits brut"}),e.jsx("div",{className:"line-value",children:a(g,t.currency)})]}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Réduction admin"}),e.jsx("div",{className:"line-value warn",children:a(b,t.currency)})]}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Montant produits net"}),e.jsx("div",{className:"line-value",children:a(p,t.currency)})]}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Livraison"}),e.jsx("div",{className:"line-value",children:a(v,t.currency)})]}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Total ventes"}),e.jsx("div",{className:"line-value",children:a(y,t.currency)})]}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Total global"}),e.jsx("div",{className:"line-value",children:a(R,t.currency)})]})]}),e.jsxs("div",{className:"section-card",children:[e.jsx("div",{className:"section-title",children:"Résumé financier"}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Produits nets"}),e.jsx("div",{className:"line-value",children:a(p,t.currency)})]}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Commission Duumini"}),e.jsx("div",{className:"line-value",children:a(t.duumini_commission,t.currency)})]}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Mode prix article"}),e.jsx("div",{className:"line-value",children:s?.item_price_mode||"—"})]}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Colonne date"}),e.jsx("div",{className:"line-value",children:s?.date_column_used||"—"})]}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Colonne livraison"}),e.jsx("div",{className:"line-value",children:s?.delivery_column_used||"—"})]})]}),e.jsxs("div",{className:"section-card",children:[e.jsx("div",{className:"section-title",children:"Paiement"}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Somme payée"}),e.jsx("div",{className:"line-value good",children:a(x,t.currency)})]}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Reste à payer"}),e.jsx("div",{className:"line-value warn",children:a(N,t.currency)})]}),e.jsx("div",{className:"grand-total",children:e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Total global"}),e.jsx("div",{className:"line-value",children:a(R,t.currency)})]})})]}),e.jsxs("div",{className:"section-card",children:[e.jsx("div",{className:"section-title",children:"Informations du rapport"}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Type"}),e.jsx("div",{className:"line-value",children:t.period_type})]}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Devise"}),e.jsx("div",{className:"line-value",children:t.currency})]}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Début période"}),e.jsx("div",{className:"line-value",children:w(t.period_start)})]}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Fin période"}),e.jsx("div",{className:"line-value",children:w(t.period_end)})]}),e.jsxs("div",{className:"line-row",children:[e.jsx("div",{className:"line-label",children:"Statuts inclus"}),e.jsx("div",{className:"line-value",children:s?.included_statuses?.length?s.included_statuses.join(", "):"—"})]})]}),e.jsxs("div",{className:"section-card span-2",children:[e.jsx("div",{className:"section-title",children:"Répartition des paiements"}),f.length?e.jsxs("table",{className:"payment-table",children:[e.jsx("thead",{children:e.jsxs("tr",{children:[e.jsx("th",{children:"Statut"}),e.jsx("th",{children:"Commandes"}),e.jsx("th",{children:"Montant total"}),e.jsx("th",{children:"Montant payé"})]})}),e.jsx("tbody",{children:f.map((r,i)=>e.jsxs("tr",{children:[e.jsx("td",{children:r?.payment_status||"—"}),e.jsx("td",{children:Number(r?.cnt||0)}),e.jsx("td",{children:a(r?.amount,t.currency)}),e.jsx("td",{children:a(r?.paid_amount,t.currency)})]},`${r?.payment_status||"row"}-${i}`))})]}):e.jsx("div",{className:"text-muted small",children:"Aucun détail de paiement disponible."})]})]}),e.jsxs("div",{className:"footer-note",children:["Merci d’utiliser Duumini",e.jsx("br",{}),"Les goûts de ton pays, partout où tu te trouves"]})]})})})]})}export{X as default};
