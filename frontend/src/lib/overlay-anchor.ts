export interface OverlayRect {x:number;y:number;width:number;height:number;}

/** A caption belongs to the rectangle's top-right edge, including at borders. */
export function topRightLabel(box:OverlayRect,label:{width:number;height:number},viewport:{width:number;height:number}):OverlayRect{
  return {...label,x:Math.max(0,Math.min(box.x+box.width-label.width,viewport.width-label.width)),
    y:Math.max(0,Math.min(box.y>=label.height?box.y-label.height:box.y,viewport.height-label.height))};
}
