"""Append verified limits without overwriting the existing science report."""
import json
from pathlib import Path
import shutil
import zipfile
from xml.dom import minidom
from xml.sax.saxutils import escape

ROOT=Path(__file__).resolve().parents[2];WORK=ROOT/'.qa/action-demo'
def main():
    stability=json.loads((WORK/'stability.json').read_text())
    samples=0;dropouts=0;with_action=0;available=0;person_instances=0
    with (WORK/'stability-frames.jsonl').open(encoding='utf-8') as stream:
        for line in stream:
            row=json.loads(line);samples+=1
            if row['elapsedMs']>3000 and row['people']==0:dropouts+=1
            if row['confirmedActions']:with_action+=1
            for track in row.get('tracks',[]):
                if track.get('personBox'):
                    person_instances+=1
                    if any(a['state'] in ('clear','confirmed') for a in track.get('actions',[])):available+=1
    stability.update(fullDropoutFrames=dropouts,framesWithConfirmedActions=with_action,
        freshActionPersonCoveragePct=100*available/person_instances if person_instances else 0,
        requestedDurationComplete=stability['durationSeconds']>=900,
        processStable=not any(f['key']!='actionsError' for f in stability['failures']) and stability['peakPrivateMB']<=2048)
    stability['functionalActionsPassed']=with_action>0 and stability['freshActionPersonCoveragePct']>=85
    stability['passed']=stability['processStable'] and stability['requestedDurationComplete'] and stability['functionalActionsPassed'] and dropouts==0
    (WORK/'stability.json').write_text(json.dumps(stability,indent=2),encoding='utf-8')
    selection=json.loads((WORK/'sav-selection.json').read_text(encoding='utf-8'))
    text=f'''\n\n## Kết quả chạy ổn định qua API — 12/11/2026\n\nĐã chạy {stability['durationSeconds']:.1f} giây, {stability['inferenceFrames']} lượt nhận diện, phát nguồn theo đồng hồ {stability['sourceFps']} FPS. Số người đồng thời cao nhất {stability['maxPeople']}; bộ nhớ riêng cao nhất toàn cây AI {stability['peakPrivateMB']:.1f} MB; P95 một lượt API {stability['p95LatencyMs']} ms. Đây là tốc độ API, không phải FPS của video và không phải độ chính xác hành vi.\n\nTrong lượt này có {dropouts} phản hồi không còn người sau khởi động và {with_action} phản hồi có hành động được xác nhận. Độ phủ kết quả hành động còn mới trên các track người là {stability['freshActionPersonCoveragePct']:.2f}%. Kết luận đạt đầy đủ: **{str(stability['passed']).lower()}**. Các số liệu này không chứng minh đạt 85%; nhánh hành động tiếp tục bị tắt mặc định. Xem số đếm/lỗi thực tế tại `.qa/action-demo/stability.json`.\n'''
    if (WORK/'stability-core.json').is_file():
        core=json.loads((WORK/'stability-core.json').read_text())
        text+=f"\nKiểm tra cấu hình mặc định (không bật nhánh hành động thử nghiệm): {core['durationSeconds']:.1f} giây, {core['inferenceFrames']} lượt, tối đa {core['maxPeople']} người, bộ nhớ cao nhất {core['peakPrivateMB']:.1f} MB, P95 API {core['p95LatencyMs']} ms, {core['fullDropoutFrames']} phản hồi mất toàn bộ track, không ghi nhận lỗi pipeline. Đây là kiểm tra ngắn 60 giây, không thay thế kết quả 15 phút của nhánh thử nghiệm.\n"
    if (WORK/'overlay-check.json').is_file():
        overlay=json.loads((WORK/'overlay-check.json').read_text())
        text+=f"\nKiểm tra trình duyệt với kết quả API thật: {overlay['people']} bbox người, {overlay['faces']} bbox mặt và {overlay['objects']} bbox đồ vật khớp tọa độ; {overlay['peopleWithoutFace']} người không thấy mặt vẫn giữ bbox người. Component thực tế được dùng trực tiếp, không dựng lại hình học ở công cụ kiểm tra. Ảnh đối chiếu: `.qa/action-demo/person-overlay.png`; số liệu: `.qa/action-demo/overlay-check.json`. Không dùng phép kiểm tra hiển thị này để suy ra độ chính xác nhận diện.\n"
    path=ROOT/'docs/prepare/NHAN_DIEN_HANH_DONG_SAV.md';current=path.read_text(encoding='utf-8')
    current=current.split('\n\n## Kết quả chạy ổn định qua API')[0]+text;path.write_text(current,encoding='utf-8')
    marker='CẬP NHẬT THEO DÕI NGƯỜI VÀ THỬ NGHIỆM SAV — 12/11/2026'
    paragraphs=[marker,
        'Giữ sáu dấu hiệu của báo cáo. Bổ sung luồng theo dõi người làm gốc, bbox người/mặt/đồ vật riêng và nhánh thử nghiệm MobileViCLIP-Tiny cho 15 nhãn SAV. Mất mặt không tự coi là người rời hình; không suy ra mắt nhắm khi không thấy mắt.',
        'Ngưỡng cập nhật: nhắm mắt 1,2 giây; điện thoại 0,6 giây; cúi đầu 1 giây; ngáp 0,7 giây; nói chuyện 1,5 giây và ít nhất ba chu kỳ miệng; laptop 1 giây. Gục bàn là tư thế bổ sung cần bằng chứng thân người và chuỗi video 1,5 giây. Cảnh báo giữ 5 giây. Các mốc cũ trong phần trình bày trước là cấu hình lịch sử.',
        'Model đã có checkpoint thật và kiểm tra tương đương ONNX, nhưng chưa được fine-tune trên SAV và chưa đạt xác minh 85%. Đo riêng Tiny khoảng 786 ms/người với hai luồng CPU; chưa đủ cập nhật nhanh 40 người. Giữ nhánh này ở chế độ thử nghiệm, không bật mặc định.',
        f"Đo API trên máy hiện tại: {stability['durationSeconds']:.1f} giây, đỉnh bộ nhớ {stability['peakPrivateMB']:.1f} MB, P95 {stability['p95LatencyMs']} ms. Có {dropouts} lượt mất toàn bộ track và {with_action} lượt có hành động xác nhận; chưa chốt tiêu chí đầy đủ.",
        f"Đã tải {selection['annotationRows']} dòng nhãn validation SAV và khóa lựa chọn {len(selection['selectedClips'])} clip bao phủ đủ 15 nhãn trước inference. Chưa lấy được video gốc; ba nguồn Youku thử đều hạn chế phát. Chưa có hai demo đủ nhãn, chưa có precision/recall/F1 SAV và không công bố đạt 85%. Chi tiết: docs/prepare/NHAN_DIEN_HANH_DONG_SAV.md."]
    report=ROOT/'docs/Student_Attention_Bao_cao_KHKT_CapNhat.docx'
    backup=WORK/'report-before-actions.docx'
    if not backup.exists():shutil.copy2(report,backup)
    with zipfile.ZipFile(report) as archive:
        original=archive.read('word/document.xml');document=minidom.parseString(original)
        if marker in original.decode('utf-8'):return
        body=document.getElementsByTagName('w:body')[0];section=next((node for node in body.childNodes if node.nodeName=='w:sectPr'),None)
        for paragraph in paragraphs:
            p=document.createElement('w:p');r=document.createElement('w:r');t=document.createElement('w:t');t.appendChild(document.createTextNode(paragraph));r.appendChild(t);p.appendChild(r)
            body.insertBefore(p,section) if section is not None else body.appendChild(p)
        target=report.with_suffix('.docx.tmp')
        with zipfile.ZipFile(target,'w') as output:
            for item in archive.infolist():output.writestr(item,document.toxml(encoding='utf-8') if item.filename=='word/document.xml' else archive.read(item.filename))
    target.replace(report)
    overview=ROOT/'docs/prepare/TONG_QUAN_CONG_NGHE_VA_LUONG_HOAT_DONG.md'
    current=overview.read_text(encoding='utf-8')
    if marker not in current:overview.write_text(current+f'\n\n## {marker}\n\nGiữ sáu dấu hiệu chính, cập nhật ngưỡng và chuyển gốc theo dõi sang người; mặt và đồ vật có bbox riêng. Nhánh 15 hành động dùng checkpoint MobileViCLIP-Tiny thật nhưng chưa đạt kiểm chứng hiệu năng/85%, nên chỉ bật thử nghiệm. Chưa có đủ media SAV để giao hai demo có nhãn. [Chi tiết triển khai, số đo và giới hạn](NHAN_DIEN_HANH_DONG_SAV.md).\n',encoding='utf-8')
    print(json.dumps(dict(stabilityPassed=stability['passed'],fullDropoutFrames=dropouts,actionFrames=with_action,docxUpdated=True)))

if __name__=='__main__':main()
