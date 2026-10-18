# usage: rtdiff.py a.json b.json — diff two round-trip exports; comps matched by order, layers by ID
import json, sys
a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2]))
IGN={'exportedAt','aeId','project','index','id'}
out=[]
def num(x): return isinstance(x,(int,float)) and not isinstance(x,bool)
def diff(x,y,p):
    if isinstance(x,dict) and isinstance(y,dict):
        for k in sorted(set(x)|set(y)):
            if k not in IGN: diff(x.get(k),y.get(k),p+'/'+k)
    elif isinstance(x,list) and isinstance(y,list):
        if len(x)!=len(y):
            nm=lambda l:[e.get('mn',e.get('name')) if isinstance(e,dict) else e for e in l]
            out.append(f"{p}: {nm(x)} -> {nm(y)}"); return
        for i,(u,v) in enumerate(zip(x,y)): diff(u,v,f"{p}[{i}]")
    elif num(x) and num(y):
        if abs(x-y)>1e-3*max(1,abs(x)): out.append(f"{p}: {x} -> {y}")
    elif x!=y: out.append(f"{p}: {x!r} -> {y!r}")
for ca,cb in zip(a['comps'],b['comps']):
    tag=ca['name']
    for k in sorted(set(ca)|set(cb)):
        if k in ('layers',)+tuple(IGN): continue
        diff(ca.get(k),cb.get(k),f"[{tag}] {k}")
    oa=[l.get('id') for l in ca['layers']]; ob=[l.get('id') for l in cb['layers']]
    la={l.get('id'):l for l in ca['layers']}; lb={l.get('id'):l for l in cb['layers']}
    for i in oa:
        if i not in lb: out.append(f"[{tag}] layer removed: {la[i]['name']}")
    for i in ob:
        if i not in la: out.append(f"[{tag}] layer added: {lb[i]['name']} ({lb[i]['type']})")
    common_a=[i for i in oa if i in lb]; common_b=[i for i in ob if i in la]
    if common_a!=common_b: out.append(f"[{tag}] layer order: {[la[i]['name'] for i in common_a]} -> {[lb[i]['name'] for i in common_b]}")
    for i in common_a:
        L=la[i]; diff(L,lb[i],f"[{tag} :: {L['name']}]")
for line in out: print(line)
print(f"-- {len(out)} differences")
