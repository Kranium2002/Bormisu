"""Coordinate parsing edge cases (fictional values)."""


def test_gauss_krueger_digit_groups_and_r_h_labels() -> None:
    from app.normalize.coordinates import parse_coordinates

    for x, y in (("r 34 21 600", "h 53 68 600"), ("R34 21 600", "H53 68 600"), ("34 21 600", "53 68 600")):
        result = parse_coordinates(x, y)
        assert result.kind == "projected" and (result.local_x, result.local_y) == (3421600.0, 5368600.0)
    labelled = parse_coordinates("R: 3419588", "H: 5369513")
    assert (labelled.local_x, labelled.local_y) == (3419588.0, 5369513.0)
    assert parse_coordinates("45 30 12", "7 15 30").kind == "geographic"  # degrees, minutes, seconds
