import type { StudentTrack } from '../lib/types';
import {useElementSize,type ElementSize} from '../hooks/useElementSize';
import { statusAppearance } from '../lib/attention';
import {activityLabel} from '../lib/activity';
import {overlayCaption} from '../lib/overlay-caption';
import OverlayLabel,{overlayLabelLayout,placeOverlayLabel} from './OverlayLabel';

/** Face rectangles stay independent from body rectangles and behavior labels. */
export default function FaceOverlay({ tracks,size:provided }: { tracks: StudentTrack[];size?:ElementSize }) {
  // Unsupported coordinates may remain in the map for an old alert, but are
  // not a current face location and must never be framed on the video.
  const faces = tracks.filter(track => track.faceVisibility!=='unavailable'&&(track.faceBox||track.boxKind==='face') && track.trackingState !== 'predicted' &&
    (track.status==='visible' || track.trackingState==='body' || track.trackingState==='coasting'))
    .map(track=>({...track,box:track.displayBoxes?.face??track.faceBox??track.box}));
  const size=useElementSize<HTMLDivElement>(provided);
  return <div className="face-overlay" ref={size.ref} aria-label="Khung nhận diện khuôn mặt">
    {size.width > 0 && <svg width={size.width} height={size.height} aria-hidden="true" style={{ display:'block', overflow:'hidden' }}>
      {faces.map(track => {
        const appearance = statusAppearance(track);
        const caption=overlayCaption(track);
        const x = track.box.x*size.width, y = track.box.y*size.height;
        const width = track.box.width*size.width, height = track.box.height*size.height;
        const recovering = track.presentation?.recovering ?? track.status === 'lost';
        const label = track.alerts?.length ? appearance.label : activityLabel(track)??(track.trackingState === 'visual' || track.trackingState === 'coasting' ? 'Đang bám mặt' :
          recovering ? track.trackingState === 'body' ? 'Bám theo người' : 'Tạm mất dấu'
            : track.studyContext === 'book' ? 'Có tương tác sách/vở' : appearance.label);
        // Paired face/body rectangles share one label at the body's top right.
        const bodyLabel=Boolean(track.personBox)&&track.status==='visible';
        const heading=caption.heading;
        const layout=overlayLabelLayout(heading,undefined,size.width);
        const placed=placeOverlayLabel({x,y,width,height},layout,size.width,size.height,[],'top-right');
        return <g key={track.id} data-face-id={'face-'+track.id} style={{opacity:track.presentation?.opacity ?? 1}}>
          <title>{caption.description+' · '+label}</title>
          <rect className="face-frame" x={x} y={y} width={width} height={height}
            data-target-x={x} data-target-y={y} data-target-width={width} data-target-height={height}
            fill="none" stroke={caption.warning?'#ef4444':'#22c55e'} strokeWidth={2} rx={0} vectorEffect="non-scaling-stroke" />
          {!bodyLabel&&<OverlayLabel x={placed.x} y={placed.y} heading={heading} layout={layout} background={caption.background} accent={caption.color} anchor={`face:face-${track.id}`}/>}
        </g>;
      })}
    </svg>}
    <ul className="sr-only">{faces.map(track=><li key={track.id}>{track.displayName}: {track.status==='lost' && !track.alerts?.length ? 'Tạm mất dấu' : statusAppearance(track).label}{track.reason ? '; '+track.reason : ''}</li>)}</ul>
  </div>;
}
