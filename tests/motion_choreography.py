"""Visual behavior checks against real composited pixels, without FFmpeg."""
import importlib.util
from pathlib import Path
import unittest
import numpy as np
from PIL import Image, ImageDraw

spec = importlib.util.spec_from_file_location('render_motion', Path(__file__).parents[1] / 'scripts/render_motion.py')
motion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(motion)


class MotionChoreography(unittest.TestCase):
    def test_separated_foreground_preserves_holes_inside_transparent_ornaments(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'ring.png'
            image = Image.new('RGB', (640, 360), (16, 40, 47))
            ImageDraw.Draw(image).ellipse((40, 20, 320, 300), outline=(113, 198, 173), width=5)
            image.save(file)
            hint = {'clearEnclosedBackground': True, 'backgroundColor': [16, 40, 47]}
            foreground, _, separated, _ = motion.prepare(file, hint)
            self.assertTrue(separated)
            self.assertEqual(foreground.getpixel((180, 160))[3], 0, 'transparent ornament holes must reveal the animated background')
            self.assertGreater(foreground.getpixel((42, 160))[3], 200, 'ornament stroke must remain foreground')

    def test_unknown_or_mismatched_backdrops_keep_enclosed_solid_regions(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'solid-plate.png'
            image = Image.new('RGB', (640, 360), (16, 40, 47))
            ImageDraw.Draw(image).ellipse((40, 20, 320, 300), outline=(113, 198, 173), width=5)
            image.save(file)
            for hint in [None, {'clearEnclosedBackground': False}, {'clearEnclosedBackground': True, 'backgroundColor': [240, 240, 240]}]:
                with self.subTest(hint=hint):
                    foreground, _, _, _ = motion.prepare(file, hint)
                    self.assertEqual(foreground.getpixel((180, 160))[3], 255, 'opaque plates, pictures and unknown source semantics must keep their occlusion')

    def test_text_exits_before_the_next_title_enters(self):
        title = Image.new('RGBA', (240, 32), (255, 255, 255, 255))
        layers = [(title, 60, 80)]
        old = motion.compose_scene(layers, (640, 360), 3, 12, 0, 'flow', -.5)
        incoming = motion.compose_scene(layers, (640, 360), 3, 12, 1, 'flow', .5)
        self.assertEqual(old.getchannel('A').getbbox(), None, 'outgoing text must clear before incoming text appears')
        self.assertEqual(incoming.getchannel('A').getbbox(), None, 'incoming text must wait until outgoing text clears')
        visible = motion.compose_scene(layers, (640, 360), 3, 12, 0, 'flow', 0)
        self.assertGreater(np.asarray(visible.getchannel('A')).sum(), 100000)

    def test_title_has_visible_breathing_motion_during_page_hold(self):
        title = Image.new('RGBA', (240, 52), (255, 255, 255, 255))
        layers = [(title, 60, 80)]
        def crop(time):
            result = motion.compose_scene(layers, (640, 360), time, 180, 0, 'flow')
            return np.asarray(result.crop((0, 40, 400, 190)).convert('RGBA')).astype(float)
        difference = np.mean(np.abs(crop(.5) - crop(2)))
        self.assertGreater(difference, 3, 'title should gently breathe during a page hold')
        early = motion.compose_scene(layers, (640, 360), .5, 180, 0, 'flow').getbbox()
        later = motion.compose_scene(layers, (640, 360), 2, 180, 0, 'flow').getbbox()
        self.assertGreater(abs((early[2] - early[0]) - (later[2] - later[0])), 1, 'title breathes in scale, in addition to drifting')

    def test_motion_is_continuous_when_a_near_edge_layer_enters_or_leaves_a_transition(self):
        # A transition with almost zero progress must look like the adjacent hold.
        # Edge constraints must not switch off when the transition starts.
        for role, dimensions in [('title', (240, 52)), ('image', (240, 160)), ('page', (640, 360))]:
            layers = [(Image.new('RGBA', dimensions, 'white'), 0, 0, role)]
            hold = np.asarray(motion.compose_scene(layers, (640, 360), 3, 12, 0, 'flow', 0)).astype(int)
            for phase in [-1e-8, 1e-8]:
                with self.subTest(role=role, phase=phase):
                    boundary = np.asarray(motion.compose_scene(layers, (640, 360), 3, 12, 0, 'flow', phase)).astype(int)
                    self.assertLessEqual(np.abs(hold - boundary).max(), 1, 'starting or finishing a transition must not jump or clip the layer')

    def test_opaque_pages_do_not_dim_during_a_crossfade(self):
        page = Image.new('RGBA', (640, 360), (90, 120, 150, 255))
        layers = [(page, 0, 0, 'page')]
        old = motion.compose_scene(layers, (640, 360), 3, 12, 0, 'flow', -.5)
        incoming = motion.compose_scene(layers, (640, 360), 3, 12, 1, 'flow', .5)
        canvas = Image.new('RGBA', (640, 360), (0, 0, 0, 255))
        canvas.alpha_composite(old)
        canvas.alpha_composite(incoming)
        self.assertEqual(canvas.getpixel((320, 180))[:3], (90, 120, 150), 'opaque page crossfades must not leak the background and dim')

    def test_ornament_changes_orientation_in_a_long_deck(self):
        ornament = Image.new('RGBA', (120, 120))
        ImageDraw.Draw(ornament).arc((8, 8, 112, 112), 0, 210, fill=(90, 210, 190), width=3)
        layers = [(ornament, 430, 80)]
        def centered(time):
            result = motion.compose_scene(layers, (640, 360), time, 180, 0, 'flow')
            bounds = result.getbbox()
            crop = result.crop(bounds)
            return np.asarray(crop.resize((160, 160)).getchannel('A')).astype(float)
        difference = np.mean(np.abs(centered(.5) - centered(2)))
        self.assertGreater(difference, 12, 'decoration should rotate independently rather than only translate over a 180-second period')


if __name__ == '__main__':
    unittest.main()
