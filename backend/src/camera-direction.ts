/** COCO nose/ear offset is a signed geometric proxy, not a measured angle.
 * Its anatomical left/right axis opposes Face Landmarker yaw. A symmetric
 * head approximation maps it to a bounded yaw estimate; never use proxy*90.
 */
export function bodyYawDegrees(proxy:number){
  if(proxy===0)return 0;
  return -Math.atan(2*proxy)*180/Math.PI;
}
export function configuredCameraYaw(){
  const value=Number(typeof process==='undefined'?0:process.env.AI_CAMERA_YAW_DEG??0);
  return Number.isFinite(value)&&Math.abs(value)<=90?value:0;
}
