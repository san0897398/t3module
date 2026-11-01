import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TaskGroup } from './TaskGroup';
import { AnimatedBeam } from './AnimatedBeam';

function Fixture() {
  const [open,setOpen]=useState(true);const container=useRef<HTMLDivElement>(null),from=useRef<HTMLDivElement>(null),to=useRef<HTMLDivElement>(null);
  useEffect(()=>{document.documentElement.dataset.ready='true';},[]);
  return <>
    <h1>UI observation fixture</h1>
    <div id="family" ref={container} className="relative" data-parent-id="root">
      <TaskGroup title="Known parent" count={1} selected open={open} onToggle={()=>setOpen(!open)} header={<div ref={from} id="parent" className="row">Known parent</div>}>
        <div id="child" ref={to} className="row" data-parent-id="root" aria-selected="true">A fixed child row with a longer title</div>
      </TaskGroup>
      <AnimatedBeam containerRef={container} fromRef={from} toRef={to} pathColor="#334455" pathOpacity={0.2} pathWidth={2} />
    </div>
    <div id="css-motion" aria-label="CSS motion without DOM mutations" />
    <div id="pseudo" data-meaning="decorative line">Pseudo-element and wrapper background</div>
    <div id="anchors" aria-hidden="true">{Array.from({length:20},(_,i)=><i key={i} style={{position:'absolute',left:20+(i%10)*24,top:430+Math.floor(i/10)*24,width:6,height:6,background:'#ff00ff'}} />)}</div>
  </>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
