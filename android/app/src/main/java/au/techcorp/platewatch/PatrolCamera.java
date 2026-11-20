package au.techcorp.platewatch;

import android.graphics.Bitmap;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.SystemClock;
import android.util.Size;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.*;
import androidx.camera.core.*;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.*;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;
import java.io.File;
import java.io.FileOutputStream;
import java.util.*;

@CapacitorPlugin(name="PatrolCamera")
public class PatrolCamera extends Plugin {
    private FrameLayout panel;
    private ProcessCameraProvider provider;
    private TextRecognizer reader;
    private ToneGenerator tone;
    private String session;
    private final Map<String,Long> lastSeen = new HashMap<>();
    private final Set<String> emitted = new HashSet<>();

    @PluginMethod public void start(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (panel != null) { call.reject("Patrol already active"); return; }
            boolean vehicle = "vehicle".equals(call.getString("mode"));
            session = UUID.randomUUID().toString();
            String current = session;
            try {
                reader = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
                tone = new ToneGenerator(AudioManager.STREAM_NOTIFICATION,70);
                panel = new FrameLayout(getContext());
                PreviewView preview = new PreviewView(getContext());
                panel.addView(preview);
                Button done = new Button(getContext());
                done.setText("Finish patrol and review");
                done.setOnClickListener(v -> finish());
                panel.addView(done,new FrameLayout.LayoutParams(-1,-2,Gravity.BOTTOM));
                getActivity().addContentView(panel,new ViewGroup.LayoutParams(-1,-1));
                var future = ProcessCameraProvider.getInstance(getContext());
                var main = ContextCompat.getMainExecutor(getContext());
                future.addListener(() -> {
                    if (!current.equals(session)) {call.reject("Patrol ended");return;}
                    try {
                        provider = future.get();
                        Preview feed = new Preview.Builder().build();
                        feed.setSurfaceProvider(preview.getSurfaceProvider());
                        ImageAnalysis analysis = new ImageAnalysis.Builder().setTargetResolution(new Size(1920,1080))
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build();
                        analysis.setAnalyzer(main,frame -> analyze(frame,current,vehicle));
                        provider.bindToLifecycle(getActivity(),CameraSelector.DEFAULT_BACK_CAMERA,feed,analysis);
                        call.resolve();
                    } catch(Exception e) {finish();call.reject("Camera unavailable",e);}
                },main);
            } catch(Exception e) {finish();call.reject("Patrol failed",e);}
        });
    }

    @androidx.camera.core.ExperimentalGetImage
    private void analyze(ImageProxy frame,String current,boolean vehicle) {
        if (!current.equals(session) || frame.getImage()==null) {frame.close();return;}
        int rotation = frame.getImageInfo().getRotationDegrees();
        long at = System.currentTimeMillis();
        InputImage image = InputImage.fromMediaImage(frame.getImage(),rotation);
        reader.process(image).addOnSuccessListener(result -> {
            if (!current.equals(session)) return;
            Set<String> seen = new HashSet<>();
            for (Text.TextBlock block:result.getTextBlocks()) for (Text.Line line:block.getLines()) {
                Rect box = line.getBoundingBox();
                String plate = line.getText().toUpperCase(Locale.ROOT).replaceAll("[ -]","");
                if (box==null || !plate.matches("[A-Z0-9]{2,8}") || box.width()<1.4*box.height()) continue;
                if (!seen.add(plate)) continue;
                long now = SystemClock.elapsedRealtime();
                Long previous = lastSeen.put(plate,now);
                if (previous==null || now-previous>(vehicle?900:1500)) {emitted.remove(plate);continue;}
                if (emitted.contains(plate)) continue;
                try {
                    Bitmap raw = frame.toBitmap();
                    Matrix m = new Matrix(); m.postRotate(rotation);
                    Bitmap upright = Bitmap.createBitmap(raw,0,0,raw.getWidth(),raw.getHeight(),m,true);
                    File path = File.createTempFile("patrol-", ".jpg",getContext().getCacheDir());
                    try(FileOutputStream out = new FileOutputStream(path)) {upright.compress(Bitmap.CompressFormat.JPEG,88,out);}
                    JSObject event = new JSObject();
                    event.put("plate",plate); event.put("at",at); event.put("path",path.getAbsolutePath());
                    event.put("x",box.left);event.put("y",box.top);event.put("width",box.width());event.put("height",box.height());
                    emitted.add(plate);
                    notifyListeners("sighting",event);
                } catch(Exception error) {finish();break;}
            }
        }).addOnCompleteListener(task -> frame.close());
    }

    @PluginMethod public void alert(PluginCall call) {
        if(tone!=null) tone.startTone(ToneGenerator.TONE_PROP_BEEP,180);
        call.resolve();
    }
    @PluginMethod public void stop(PluginCall call) {getActivity().runOnUiThread(() -> {finish();call.resolve();});}
    @PluginMethod public void release(PluginCall call) {
        String path = call.getString("path","");
        File f = new File(path);
        if (getContext().getCacheDir().equals(f.getParentFile()) && f.getName().startsWith("patrol-")) f.delete();
        call.resolve();
    }
    private void finish() {
        if(panel==null)return;
        session=null;
        if(provider!=null)provider.unbindAll();
        if(reader!=null)reader.close();
        if(tone!=null){tone.release();tone=null;}
        ((ViewGroup)panel.getParent()).removeView(panel);
        panel=null;lastSeen.clear();emitted.clear();
        notifyListeners("finished",new JSObject());
    }
    @Override protected void handleOnDestroy(){finish();}
}
